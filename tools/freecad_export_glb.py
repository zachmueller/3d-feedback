"""Export a FreeCAD document to a single .glb for the 3d viewer.

Two ways to run it:

    # inside a running FreeCAD (this is what freecad-mcp's Python execution does)
    exec(open('/path/to/tools/freecad_export_glb.py').read())
    export_glb('/tmp/towel-clip.glb')

    # headless, from a shell
    freecadcmd tools/freecad_export_glb.py -- /tmp/towel-clip.glb --fcstd part.FCStd

What it exports: every *top-level*, visible object that has faces. Parts and
bodies nested inside another container are skipped, because their parent already
carries them — exporting both would draw the same geometry twice.

Why it matters for the viewer: OCCT's glTF writer names each node after the
FreeCAD object's Label, and those names are exactly what the viewer's parts panel
lists and toggles. Renaming a body in the model tree renames the checkbox.
"""

import os
import sys

import FreeCAD  # noqa: F401  (provided by the FreeCAD runtime)


def _is_visible(obj):
    """Console mode has no ViewObject, so absence of one counts as visible."""
    view = getattr(obj, "ViewObject", None)
    if view is None:
        return True
    return bool(getattr(view, "Visibility", True))


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
    "PartDesign::Body",
    "Part::Feature",
    "Part::BooleanOperation",
    "Part::MultiFuse",
    "Part::MultiCommon",
    "Part::Cut",
)


def _is_top_level(obj):
    for parent in obj.InList:
        for kind in _CONTAINERS:
            try:
                if parent.isDerivedFrom(kind):
                    return False
            except Exception:
                continue
    return True


def selectable_objects(doc):
    """The objects that should end up as nodes in the .glb."""
    return [
        obj
        for obj in doc.Objects
        if _is_visible(obj) and _has_faces(obj) and _is_top_level(obj)
    ]


def _set_tessellation(linear_deflection, angular_deflection):
    """Optionally tighten the export tessellation.

    Faceted-looking curves in the viewer come from OCCT's meshing tolerances, not
    from the viewer. These preference keys are read by the glTF writer; the names
    have moved between FreeCAD versions, so failures here are non-fatal and
    reported rather than raised.
    """
    if linear_deflection is None and angular_deflection is None:
        return
    try:
        params = FreeCAD.ParamGet("User parameter:BaseApp/Preferences/Mod/Import")
        if linear_deflection is not None:
            params.SetFloat("LinearDeflection", float(linear_deflection))
        if angular_deflection is not None:
            params.SetFloat("AngularDeflection", float(angular_deflection))
    except Exception as err:  # pragma: no cover - depends on the FreeCAD build
        print("warning: could not set tessellation preferences: %s" % err)


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

    _set_tessellation(linear_deflection, angular_deflection)

    directory = os.path.dirname(os.path.abspath(path))
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)

    # ImportGui carries per-face colours into the glTF materials; plain Import is
    # the console-only fallback and exports geometry without them.
    try:
        import ImportGui as exporter
    except ImportError:
        import Import as exporter

    exporter.export(targets, path)

    labels = [obj.Label for obj in targets]
    size = os.path.getsize(path)
    print("exported %d object(s) to %s (%.1f KB)" % (len(labels), path, size / 1024.0))
    for label in labels:
        print("  - %s" % label)
    return labels


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
            "[--linear-deflection MM] [--angular-deflection RAD]"
        )

    doc = FreeCAD.openDocument(fcstd) if fcstd else FreeCAD.ActiveDocument
    export_glb(path, doc=doc, linear_deflection=linear, angular_deflection=angular)


if __name__ == "__main__":
    _main(sys.argv[1:])
