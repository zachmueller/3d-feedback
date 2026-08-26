"""Export a FreeCAD document to a single .glb for the 3d viewer.

Two ways to run it:

    # inside a running FreeCAD (this is what freecad-mcp's Python execution does)
    exec(open('/path/to/tools/freecad_export_glb.py').read())
    export_glb('/tmp/towel-clip.glb')

    # headless, from a shell
    freecadcmd tools/freecad_export_glb.py -- /tmp/towel-clip.glb --fcstd part.FCStd

What it exports: every *top-level*, visible object that has faces. Parts and
bodies nested inside another container are skipped, because their parent already
carries them — exporting both would draw the same geometry twice. Datum and origin
geometry is skipped too: it is a construction aid, never printed geometry, and it
would otherwise arrive as junk checkboxes in the viewer's parts panel.

Label an object `ref_Something` to mark it as reference geometry — the thing your
part mounts to rather than the part itself. It is still exported, but the viewer
lists it as "Something (reference)" with its checkbox off, so a reviewer sees the
printed parts first and can switch the context back on.

Why naming matters for the viewer: OCCT's glTF writer names each node after the
FreeCAD object's Label, and those names are exactly what the viewer's parts panel
lists and toggles. Renaming a body in the model tree renames the checkbox.

Mesh quality is set per object and differently in each mode — see
`_apply_view_tessellation` (GUI) and `_tessellate_shapes` (console).

Headless caveats, all confirmed against FreeCAD 1.1.3:

* FreeCAD also tries to open every positional argument as a document, so it prints
  `Exception while processing file: out.glb` for the output path. Harmless noise.
* Console mode has no view provider, so `ImportGui` is unavailable and plain
  `Import` exports without per-face colours.
* `freecadcmd` block-buffers stdout and exits without flushing, so the CLI path
  flushes by hand or you see none of its output.
"""

import os
import sys

import FreeCAD  # noqa: F401  (provided by the FreeCAD runtime)


def _is_visible(obj):
    view = getattr(obj, "ViewObject", None)
    if view is not None:
        return bool(getattr(view, "Visibility", True))
    # Console mode has no view provider, but FreeCAD 1.x mirrors visibility onto
    # the object itself, so a body hidden in the GUI still reports False here.
    return bool(getattr(obj, "Visibility", True))


def _has_faces(obj):
    shape = getattr(obj, "Shape", None)
    if shape is None:
        return False
    try:
        return not shape.isNull() and len(shape.Faces) > 0
    except Exception:
        return False


# Container types that own their children for export purposes: if one of these
# claims an object, exporting the object as well would duplicate geometry.
_CONTAINERS = (
    "App::Part",
    "App::DocumentObjectGroup",
    # An App::Origin is the only parent its three planes have. Without it here they
    # look top-level, and they pass every other filter — each plane has one face,
    # and FreeCAD hides the Origin group while leaving its members individually
    # visible. That combination put XY/XZ/YZ-plane in the parts panel.
    "App::Origin",
    "PartDesign::Body",
    "Part::Feature",
    "Part::BooleanOperation",
    "Part::MultiFuse",
    "Part::MultiCommon",
    "Part::Cut",
)

# Datum and origin geometry: construction aids that carry a face or two but are
# never printed. `PartDesign::Plane` and friends all derive from `Part::Datum`,
# which is the one entry that matters; the rest are named for clarity and for
# builds where the hierarchy differs. An unknown name is simply never matched.
_DATUM_TYPES = (
    "App::Origin",
    "App::OriginFeature",
    "App::Plane",
    "App::Line",
    "App::Point",
    "Part::Datum",
)


def _derives_from_any(obj, kinds):
    for kind in kinds:
        try:
            if obj.isDerivedFrom(kind):
                return True
        except Exception:
            continue
    return False


def _is_datum(obj):
    return _derives_from_any(obj, _DATUM_TYPES)


def _is_top_level(obj):
    for parent in obj.InList:
        if _derives_from_any(parent, _CONTAINERS):
            return False
    return True


def selectable_objects(doc):
    """The objects that should end up as nodes in the .glb."""
    return [
        obj
        for obj in doc.Objects
        if _is_visible(obj)
        and _has_faces(obj)
        and _is_top_level(obj)
        and not _is_datum(obj)
    ]


# FreeCAD's own default for ViewObject.Deviation, whose property documentation
# reads "The value is in percent of object's size".
_DEFAULT_DEVIATION = 0.5


def _apply_view_tessellation(targets, linear_deflection, angular_deflection):
    """Tighten the triangulation the exporter will read; return an undo list.

    The knob is per-object and lives on the *view provider*: `ImportGui` meshes
    from the view provider's triangulation, so `ViewObject.Deviation` (percent of
    the object's size, default 0.5) and `ViewObject.AngularDeflection` (degrees,
    default 28.5) are what govern export quality.

    This used to write `LinearDeflection` / `AngularDeflection` under
    `Preferences/Mod/Import` instead. Nothing reads those keys — but `ParamGet`
    creates whatever key it is handed, so the writes "succeeded" and the export was
    byte-identical no matter what you asked for. Hence the explicit reporting
    below: a tessellation setting that silently does nothing sends you looking for
    a viewer bug that isn't there.

    Restoring the old values leaves the geometry as it was, though FreeCAD may
    still consider the document modified afterwards.
    """
    if linear_deflection is None and angular_deflection is None:
        return []

    if angular_deflection is not None and angular_deflection < 1.0:
        print(
            "warning: angular_deflection=%g looks like radians — AngularDeflection "
            "is in degrees and defaults to 28.5, so this will produce a very fine "
            "mesh" % angular_deflection
        )

    wanted = (("Deviation", linear_deflection), ("AngularDeflection", angular_deflection))
    saved = []
    previous = {}
    headless = 0

    for obj in targets:
        view = getattr(obj, "ViewObject", None)
        if view is None:
            headless += 1
            continue
        for prop, value in wanted:
            if value is None or not hasattr(view, prop):
                continue
            old = getattr(view, prop)
            saved.append((view, prop, old))
            previous.setdefault(prop, set()).add(float(old))
            setattr(view, prop, float(value))

    if headless:
        # Shouldn't happen: this path only runs when ImportGui loaded, which means
        # there is a GUI. Say so rather than silently skipping objects.
        print(
            "warning: %d of %d object(s) have no view provider and were left at "
            "the default quality" % (headless, len(targets))
        )

    for prop, value in wanted:
        if value is None:
            continue
        touched = sum(1 for _view, name, _old in saved if name == prop)
        if not touched:
            print(
                "warning: no object exposes %s, so %s was NOT applied" % (prop, value)
            )
            continue
        was = ", ".join("%g" % v for v in sorted(previous[prop]))
        print(
            "tessellation: %s %s → %g on %d object(s)" % (prop, was, value, touched)
        )

    return saved


def _restore_tessellation(saved):
    for view, prop, value in reversed(saved):
        try:
            setattr(view, prop, value)
        except Exception as err:  # pragma: no cover - depends on the FreeCAD build
            print("warning: could not restore %s: %s" % (prop, err))


def _shapes_to_mesh(targets):
    """Every shape the glTF writer will visit: the targets and their descendants.

    A container node is written with its children as separate glTF nodes, so
    triangulating only the container's aggregate shape leaves those children empty.
    """
    seen = {}
    for obj in targets:
        candidates = [obj]
        try:
            candidates.extend(obj.OutListRecursive)
        except Exception:
            pass
        for candidate in candidates:
            shape = getattr(candidate, "Shape", None)
            if shape is not None and candidate.Name not in seen:
                seen[candidate.Name] = shape
    return list(seen.values())


def _tessellate_shapes(targets, deviation, angular_deflection):
    """Triangulate the shapes for a console-mode export.

    Not an optimization — a requirement. OCCT's glTF writer takes the triangulation
    off the shape, and console mode has no view provider to have built one, so it
    skips every node: a headless export without this writes a *valid but empty*
    .glb (312 bytes, zero meshes) while reporting success.

    `deviation` keeps the GUI meaning — percent of the object's size — and is
    converted per shape against its bounding-box diagonal, so the same argument
    asks for the same quality in both modes.
    """
    percent = _DEFAULT_DEVIATION if deviation is None else float(deviation)
    if angular_deflection is not None:
        print(
            "warning: angular_deflection is a view-provider property and has no "
            "console-mode equivalent; ignoring %g" % angular_deflection
        )

    meshed = 0
    for shape in _shapes_to_mesh(targets):
        try:
            diagonal = shape.BoundBox.DiagonalLength
        except Exception:
            diagonal = 0.0
        deflection = (percent / 100.0) * diagonal
        if deflection <= 0:
            continue
        try:
            shape.tessellate(deflection)
            meshed += 1
        except Exception as err:
            print("warning: could not tessellate a shape: %s" % err)

    print(
        "tessellation: triangulated %d shape(s) at %g%% of size (console mode: "
        "plain Import, so no per-face colours)" % (meshed, percent)
    )


def export_glb(
    path,
    doc=None,
    objects=None,
    linear_deflection=None,
    angular_deflection=None,
):
    """Write `path` (a .glb) and return the list of exported object labels."""
    if not str(path).lower().endswith(".glb"):
        raise ValueError("path must end in .glb (binary glTF)")

    document = doc or FreeCAD.ActiveDocument
    if document is None:
        raise RuntimeError("no active document — open one or pass doc=")

    # A document just built by a script may still hold un-recomputed features,
    # whose Shape would export empty.
    if getattr(document, "RecomputesFrozen", False):
        document.RecomputesFrozen = False
    document.recompute()

    targets = objects if objects is not None else selectable_objects(document)
    if not targets:
        raise RuntimeError(
            "nothing to export: no visible top-level object with faces was found"
        )

    directory = os.path.dirname(os.path.abspath(path))
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)

    # ImportGui carries per-face colours into the glTF materials; plain Import is
    # the console-only fallback and exports geometry without them.
    try:
        import ImportGui as gltf_exporter

        have_gui = True
    except ImportError:
        import Import as gltf_exporter

        have_gui = False

    saved = []
    if have_gui:
        saved = _apply_view_tessellation(targets, linear_deflection, angular_deflection)
        if saved:
            # Changing Deviation dirties each view provider; draw once so the
            # exporter reads the new triangulation rather than the cached one.
            try:
                import FreeCADGui

                FreeCADGui.updateGui()
            except Exception:
                pass
    else:
        _tessellate_shapes(targets, linear_deflection, angular_deflection)

    try:
        gltf_exporter.export(targets, path)
    finally:
        _restore_tessellation(saved)

    labels = [obj.Label for obj in targets]
    size = os.path.getsize(path)
    print("exported %d object(s) to %s (%.1f KB)" % (len(labels), path, size / 1024.0))
    for label in labels:
        print("  - %s" % label)
    return labels


def _open_document(fcstd):
    """FreeCAD opens positional arguments itself, so it may already be loaded."""
    target = os.path.abspath(fcstd)
    for document in FreeCAD.listDocuments().values():
        if document.FileName and os.path.abspath(document.FileName) == target:
            return document
    return FreeCAD.openDocument(fcstd)


def _main(argv):
    args = list(argv)
    if "--" in args:
        args = args[args.index("--") + 1 :]

    path = None
    fcstd = None
    linear = None
    angular = None
    while args:
        arg = args.pop(0)
        if arg == "--fcstd":
            fcstd = args.pop(0)
        elif arg == "--linear-deflection":
            linear = float(args.pop(0))
        elif arg == "--angular-deflection":
            angular = float(args.pop(0))
        elif arg.startswith("-"):
            raise SystemExit("unknown flag %s" % arg)
        elif path is None:
            path = arg
        else:
            raise SystemExit("unexpected argument %s" % arg)

    if path is None:
        raise SystemExit(
            "usage: freecadcmd freecad_export_glb.py -- OUT.glb [--fcstd DOC.FCStd] "
            "[--linear-deflection PERCENT] [--angular-deflection DEGREES]"
        )

    doc = _open_document(fcstd) if fcstd else FreeCAD.ActiveDocument
    try:
        export_glb(path, doc=doc, linear_deflection=linear, angular_deflection=angular)
    finally:
        # freecadcmd exits without flushing Python's buffered stdout.
        sys.stdout.flush()


# freecadcmd imports the script as a module rather than running it as __main__, so
# the usual guard alone never fires and the documented headless command did nothing
# at all. Keying off the `--` separator runs the CLI in that case while leaving
# `import freecad_export_glb` (which the selftest does) side-effect free.
if __name__ == "__main__" or "--" in sys.argv:
    _main(sys.argv[1:])
