"""Regression test for the exporter's selection rules. Run it headlessly:

    npm run test:freecad
    # or directly
    freecadcmd tools/freecad_selftest.py

It builds, in memory, the document shape that no model in the vault has — an
`App::Part` container with its auto-created `App::Origin`, a hidden body, a
`PartDesign` datum plane, and a label containing both a space and a dot — then
asserts `selectable_objects()` returns exactly the two real bodies. Both bugs found
when step 6 was first run would have failed this: origin planes have one face each
and are individually visible, so they passed every filter the exporter had.

Console mode is the only mode that can be automated (no GUI, no view provider), so
this covers the selection rules and node naming. Tessellation is a GUI-only
concern — see the warning `export_glb` prints when it cannot apply it.
"""

import json
import os
import struct
import sys
import tempfile

import FreeCAD

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import freecad_export_glb as exporter  # noqa: E402


# The two real bodies. Everything else in the fixture is scaffolding that must not
# reach the viewer's parts panel.
EXPECTED = ["Base Plate.v2", "Sub Assembly"]

failures = []
notes = []


def check(ok, description, detail=""):
    # freecadcmd block-buffers stdout and exits without flushing it, so an
    # unflushed line is a line you never see.
    print("%s  %s" % ("pass" if ok else "FAIL", description), flush=True)
    if not ok:
        if detail:
            print("      %s" % detail, flush=True)
        failures.append(description)


def build_fixture(doc):
    """Every object here exists to exercise one filter."""
    # A space *and* a dot: three.js mangles both, so this is the label the viewer's
    # nameResolver() has to recover from the raw glTF.
    plate = doc.addObject("Part::Box", "Plate")
    plate.Label = "Base Plate.v2"

    # An App::Part reports its children's aggregate Shape, so the container itself
    # is the node to export — and adding it brings a free App::Origin with three
    # one-face planes, which is exactly the leak.
    container = doc.addObject("App::Part", "Container")
    container.Label = "Sub Assembly"
    for name in ("KidA", "KidB"):
        container.addObject(doc.addObject("Part::Box", name))

    hidden = doc.addObject("Part::Box", "HiddenBox")
    hidden.Label = "Hidden Thing"
    # Console mode has no ViewObject; FreeCAD 1.x mirrors visibility onto the
    # object, which is what _is_visible() falls back to.
    hidden.Visibility = False

    body = doc.addObject("PartDesign::Body", "Body")
    body.addObject(doc.addObject("PartDesign::Plane", "DatumPlane"))

    doc.recompute()


def parse_glb(path):
    """Node names and triangle count out of a .glb, without a glTF library."""
    with open(path, "rb") as handle:
        data = handle.read()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("not a binary glTF: %r" % magic)
    offset = 12
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<I4s", data, offset)
        offset += 8
        if chunk_type == b"JSON":
            gltf = json.loads(data[offset : offset + chunk_length].decode("utf-8"))
            triangles = 0
            for mesh in gltf.get("meshes", []):
                for primitive in mesh.get("primitives", []):
                    indices = primitive.get("indices")
                    if indices is not None:
                        triangles += gltf["accessors"][indices]["count"] // 3
            return [node.get("name", "") for node in gltf.get("nodes", [])], triangles
        offset += chunk_length
    raise ValueError("no JSON chunk found")


def main():
    doc = FreeCAD.newDocument("ExporterSelftest")
    build_fixture(doc)

    labels = [obj.Label for obj in exporter.selectable_objects(doc)]
    check(
        labels == EXPECTED,
        "selectable_objects() returns the two real bodies",
        "expected %r\n      got      %r" % (EXPECTED, labels),
    )

    # Name the individual rules too, so a failure says which one broke rather than
    # just handing over a list diff. The datum set is derived from FreeCAD's own
    # type hierarchy rather than from the module under test, so the check stands on
    # its own.
    by_label = {obj.Label: obj for obj in doc.Objects}
    datum_labels = {
        obj.Label
        for obj in doc.Objects
        if any(
            obj.isDerivedFrom(kind)
            for kind in ("App::Plane", "App::Line", "App::Point", "Part::Datum")
        )
    }
    leaked = [label for label in labels if label in datum_labels]
    check(not leaked, "origin and datum geometry is excluded", "leaked: %r" % leaked)
    check("Hidden Thing" not in labels, "hidden objects are excluded")
    check("KidA" not in labels and "KidB" not in labels,
          "children of an App::Part are left to their parent")
    check(exporter._is_datum(by_label["Base Plate.v2"]) is False,
          "_is_datum() does not reject real geometry")
    check(exporter._is_datum(doc.getObject("DatumPlane")) is True,
          "_is_datum() recognises a PartDesign datum")

    out = os.path.join(tempfile.mkdtemp(prefix="threed-selftest-"), "selftest.glb")
    exporter.export_glb(out, doc=doc)
    names, triangles = parse_glb(out)

    # The headless export used to write a 312-byte glTF with zero meshes: OCCT skips
    # any node whose shape has no triangulation, and console mode has no view
    # provider to have built one. Assert on geometry, not just on a non-empty file.
    check(triangles > 0, "the exported .glb has geometry", "%d triangles" % triangles)
    check(
        all(label in names for label in EXPECTED),
        "labels survive into the .glb as node names",
        "expected %r within %r" % (EXPECTED, names),
    )

    os.remove(out)
    FreeCAD.closeDocument(doc.Name)

    for note in notes:
        print("note: %s" % note, flush=True)
    if failures:
        print("\n%d check(s) failed" % len(failures), flush=True)
        return 1
    print("\nall checks passed", flush=True)
    return 0


# No __main__ guard: freecadcmd imports the script as a module, so __name__ is
# "freecad_selftest" and the guard would never fire. This file is only ever run,
# never imported.
sys.exit(main())
