#!/usr/bin/env python3
"""Genera archivos de prueba georreferenciados para el visor.

Salida (en tests/fixtures/):
  edificio_georef_ifc4.ifc   IFC4 con IfcMapConversion (EPSG:32718, rotación 15°)
  edificio_site_ifc2x3.ifc   IFC2X3 sin IfcMapConversion; el IfcSite está
                             colocado directamente en coordenadas UTM
  planta_georef.dxf          DXF en metros ($INSUNITS=6) con la huella del
                             edificio, ejes, lote, textos y bloques en UTM
  fixtures.json              Valores de referencia para las pruebas

Los tres archivos deben quedar alineados en el visor: la huella del DXF
coincide con los muros de ambos IFC (en planta).

Requiere: pip install ifcopenshell ezdxf
"""
import json
import math
import os

import numpy as np
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.api.root
import ifcopenshell.api.unit
import ifcopenshell.api.context
import ifcopenshell.api.aggregate
import ifcopenshell.api.spatial
import ifcopenshell.api.geometry
import ifcopenshell.api.style
import ifcopenshell.api.pset
import ifcopenshell.api.georeference
import ifcopenshell.api.owner
import ifcopenshell.api.owner.settings
import ezdxf

HERE = os.path.dirname(os.path.abspath(__file__))

# Georreferencia (UTM 18S, zona de Lima)
EASTINGS = 279500.0
NORTHINGS = 8661000.0
HEIGHT = 150.0
ROT_DEG = 15.0
ROT = math.radians(ROT_DEG)

# Edificio en coordenadas locales (m)
W, D = 12.0, 8.0  # ancho (X), fondo (Y)
WALL_T = 0.2
STOREY_H = 3.0
STOREYS = [("Nivel 1", 0.0), ("Nivel 2", STOREY_H)]

COLORS = {
    "wall": (0.85, 0.83, 0.80),
    "slab": (0.60, 0.60, 0.62),
    "column": (0.45, 0.45, 0.48),
    "furniture": (0.45, 0.30, 0.18),
    "glass": (0.55, 0.75, 0.90),
}


def local_to_map(x, y, z=0.0):
    e = EASTINGS + x * math.cos(ROT) - y * math.sin(ROT)
    n = NORTHINGS + x * math.sin(ROT) + y * math.cos(ROT)
    return e, n, HEIGHT + z


def placement_matrix(x, y, z, angle=0.0):
    m = np.eye(4)
    c, s = math.cos(angle), math.sin(angle)
    m[0][0], m[0][1] = c, -s
    m[1][0], m[1][1] = s, c
    m[0][3], m[1][3], m[2][3] = x, y, z
    return m


def build_ifc(schema, georef_mode):
    f = ifcopenshell.file(schema=schema)
    if schema == "IFC2X3":
        # IFC2X3 exige OwnerHistory en cada entidad raíz
        person = ifcopenshell.api.owner.add_person(f)
        org = ifcopenshell.api.owner.add_organisation(f)
        user = ifcopenshell.api.owner.add_person_and_organisation(f, person=person, organisation=org)
        app = ifcopenshell.api.owner.add_application(f)
        ifcopenshell.api.owner.settings.get_user = lambda _f: user
        ifcopenshell.api.owner.settings.get_application = lambda _f: app
    project =ifcopenshell.api.root.create_entity(f, ifc_class="IfcProject", name="Proyecto Demo 5D")
    project.LongName = "Edificio Demo Georreferenciado"
    length = ifcopenshell.api.unit.add_si_unit(f, unit_type="LENGTHUNIT")
    area = ifcopenshell.api.unit.add_si_unit(f, unit_type="AREAUNIT")
    volume = ifcopenshell.api.unit.add_si_unit(f, unit_type="VOLUMEUNIT")
    ifcopenshell.api.unit.assign_unit(f, units=[length, area, volume])
    model3d = ifcopenshell.api.context.add_context(f, context_type="Model")
    body = ifcopenshell.api.context.add_context(
        f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model3d
    )

    if georef_mode == "mapconversion":
        ifcopenshell.api.georeference.add_georeferencing(f, ifc_class="IfcMapConversion", name="EPSG:32718")
        ifcopenshell.api.georeference.edit_georeferencing(
            f,
            projected_crs={"Name": "EPSG:32718", "Description": "WGS 84 / UTM zone 18S"},
            coordinate_operation={
                "Eastings": EASTINGS,
                "Northings": NORTHINGS,
                "OrthogonalHeight": HEIGHT,
                "XAxisAbscissa": math.cos(ROT),
                "XAxisOrdinate": math.sin(ROT),
                "Scale": 1.0,
            },
        )

    site = ifcopenshell.api.root.create_entity(f, ifc_class="IfcSite", name="Terreno")
    building = ifcopenshell.api.root.create_entity(f, ifc_class="IfcBuilding", name="Edificio A")
    ifcopenshell.api.aggregate.assign_object(f, relating_object=project, products=[site])
    ifcopenshell.api.aggregate.assign_object(f, relating_object=site, products=[building])

    # edit_object_placement recibe matrices globales: todo se compone con la del sitio
    if georef_mode == "siteplacement":
        # Coordenadas UTM directamente en la colocación del sitio
        site_m = placement_matrix(EASTINGS, NORTHINGS, HEIGHT, ROT)
    else:
        site_m = np.eye(4)
    ifcopenshell.api.geometry.edit_object_placement(f, product=site, matrix=site_m)
    ifcopenshell.api.geometry.edit_object_placement(f, product=building, matrix=site_m.copy())

    styles = {}
    for key, rgb in COLORS.items():
        st = ifcopenshell.api.style.add_style(f, name=key)
        attrs = {"SurfaceColour": {"Name": None, "Red": rgb[0], "Green": rgb[1], "Blue": rgb[2]}}
        if key == "glass":
            attrs["Transparency"] = 0.6
        cls = "IfcSurfaceStyleRendering" if (schema == "IFC2X3" and key == "glass") else "IfcSurfaceStyleShading"
        if cls == "IfcSurfaceStyleRendering":
            attrs["ReflectanceMethod"] = "NOTDEFINED"
        ifcopenshell.api.style.add_surface_style(f, style=st, ifc_class=cls, attributes=attrs)
        styles[key] = st

    def place(product, rep, matrix, style_key, storey):
        ifcopenshell.api.geometry.assign_representation(f, product=product, representation=rep)
        ifcopenshell.api.geometry.edit_object_placement(f, product=product, matrix=site_m @ matrix)
        ifcopenshell.api.style.assign_representation_styles(f, shape_representation=rep, styles=[styles[style_key]])
        ifcopenshell.api.spatial.assign_container(f, relating_structure=storey, products=[product])

    counts = {}
    for sname, elev in STOREYS:
        storey = ifcopenshell.api.root.create_entity(f, ifc_class="IfcBuildingStorey", name=sname)
        storey.Elevation = elev
        ifcopenshell.api.aggregate.assign_object(f, relating_object=building, products=[storey])
        ifcopenshell.api.geometry.edit_object_placement(f, product=storey, matrix=site_m @ placement_matrix(0, 0, elev))

        # Losa
        slab = ifcopenshell.api.root.create_entity(f, ifc_class="IfcSlab", name=f"Losa {sname}")
        rep = ifcopenshell.api.geometry.add_slab_representation(
            f, context=body, depth=0.2, polyline=[(0, 0), (W, 0), (W, D), (0, D)]
        )
        place(slab, rep, placement_matrix(0, 0, elev - 0.2), "slab", storey)

        # Muros perimetrales (eje exterior en el borde del rectángulo)
        walls = [
            ((0, 0), 0.0, W),
            ((W, 0), math.pi / 2, D),
            ((W, D), math.pi, W),
            ((0, D), -math.pi / 2, D),
        ]
        for i, ((x, y), ang, length_) in enumerate(walls):
            wall = ifcopenshell.api.root.create_entity(f, ifc_class="IfcWall", name=f"Muro {sname} M{i+1:02d}")
            rep = ifcopenshell.api.geometry.add_wall_representation(
                f, context=body, length=length_, height=STOREY_H - 0.2, thickness=WALL_T
            )
            place(wall, rep, placement_matrix(x, y, elev, ang), "wall", storey)
            pset = ifcopenshell.api.pset.add_pset(f, product=wall, name="Pset_WallCommon")
            ifcopenshell.api.pset.edit_pset(f, pset=pset, properties={"IsExternal": True, "FireRating": "EI60"})
            p2 = ifcopenshell.api.pset.add_pset(f, product=wall, name="CT_Partida")
            ifcopenshell.api.pset.edit_pset(
                f, pset=p2, properties={"Codigo": f"02.01.{i+1:02d}", "Descripcion": "Muro de albañilería"}
            )

        # Columnas
        for (cx, cy) in [(4.0, 4.0), (8.0, 4.0)]:
            col = ifcopenshell.api.root.create_entity(f, ifc_class="IfcColumn", name=f"Columna {sname}")
            rep = ifcopenshell.api.geometry.add_wall_representation(
                f, context=body, length=0.3, height=STOREY_H - 0.2, thickness=0.3
            )
            place(col, rep, placement_matrix(cx - 0.15, cy - 0.15, elev), "column", storey)

        # Mobiliario (cajas) y una ventana de vidrio
        for j, (fx, fy, fl, ft) in enumerate([(1.0, 1.0, 2.0, 0.6), (6.0, 6.0, 3.0, 1.0)]):
            fur = ifcopenshell.api.root.create_entity(
                f, ifc_class="IfcFurnishingElement" if schema == "IFC2X3" else "IfcFurniture",
                name=f"Mueble {sname} {j+1}"
            )
            rep = ifcopenshell.api.geometry.add_wall_representation(
                f, context=body, length=fl, height=0.9, thickness=ft
            )
            place(fur, rep, placement_matrix(fx, fy, elev), "furniture", storey)

        win = ifcopenshell.api.root.create_entity(f, ifc_class="IfcWindow", name=f"Ventana {sname}")
        rep = ifcopenshell.api.geometry.add_wall_representation(f, context=body, length=2.0, height=1.2, thickness=0.05)
        place(win, rep, placement_matrix(5.0, -0.05, elev + 1.0), "glass", storey)
        counts[sname] = 4 + 2 + 2 + 1 + 1
    return f, counts


def build_dxf(path):
    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 6  # metros
    msp = doc.modelspace()
    layers = {
        "MUROS": 7, "EJES": 1, "LOTE": 3, "TEXTOS": 2, "ARBOLES": 94, "MOBILIARIO": 30,
    }
    for name, color in layers.items():
        doc.layers.add(name, color=color)

    def P(x, y):
        e, n, _ = local_to_map(x, y)
        return (e, n)

    # Huella exterior e interior de muros
    msp.add_lwpolyline([P(0, 0), P(W, 0), P(W, D), P(0, D)], close=True, dxfattribs={"layer": "MUROS"})
    t = WALL_T
    # Los muros generados por add_wall_representation crecen hacia +Y local del muro,
    # es decir hacia el interior del rectángulo.
    msp.add_lwpolyline([P(t, t), P(W - t, t), P(W - t, D - t), P(t, D - t)], close=True,
                       dxfattribs={"layer": "MUROS"})
    # Ejes
    for i, x in enumerate([0.0, 4.0, 8.0, 12.0]):
        msp.add_line(P(x, -3), P(x, D + 3), dxfattribs={"layer": "EJES"})
        msp.add_circle(P(x, D + 3.6), 0.6, dxfattribs={"layer": "EJES"})
        msp.add_text(str(i + 1), height=0.5, dxfattribs={"layer": "TEXTOS", "insert": P(x - 0.15, D + 3.35)})
    for j, y in enumerate([0.0, 4.0, 8.0]):
        msp.add_line(P(-3, y), P(W + 3, y), dxfattribs={"layer": "EJES"})
        msp.add_text("ABC"[j], height=0.5, dxfattribs={"layer": "TEXTOS", "insert": P(-4.2, y - 0.25)})
    # Lote con arco (bulge)
    lot = [P(-8, -8), P(W + 8, -8), P(W + 8, D + 8), P(-8, D + 8)]
    msp.add_lwpolyline([(*lot[0], 0), (*lot[1], 0.3), (*lot[2], 0), (*lot[3], 0)],
                       format="xyb", close=True, dxfattribs={"layer": "LOTE"})
    msp.add_text("LOTE 01 - Planta de Ubicación", height=0.8,
                 dxfattribs={"layer": "TEXTOS", "insert": P(-7, -7), "rotation": ROT_DEG})
    # Bloque árbol
    blk = doc.blocks.new(name="ARBOL")
    blk.add_circle((0, 0), 1.0)
    blk.add_line((-1, 0), (1, 0))
    blk.add_line((0, -1), (0, 1))
    for (x, y) in [(-5, -5), (W + 5, -5), (W + 5, D + 5), (-5, D + 5)]:
        msp.add_blockref("ARBOL", P(x, y), dxfattribs={"layer": "ARBOLES", "xscale": 1.2, "yscale": 1.2})
    # Mobiliario 2D (contornos de los muebles del Nivel 1)
    for (fx, fy, fl, ft) in [(1.0, 1.0, 2.0, 0.6), (6.0, 6.0, 3.0, 1.0)]:
        msp.add_lwpolyline([P(fx, fy), P(fx + fl, fy), P(fx + fl, fy + ft), P(fx, fy + ft)], close=True,
                           dxfattribs={"layer": "MOBILIARIO"})
    doc.saveas(path)


def main():
    out = {}
    f4, counts = build_ifc("IFC4", "mapconversion")
    p4 = os.path.join(HERE, "edificio_georef_ifc4.ifc")
    f4.write(p4)
    f2, _ = build_ifc("IFC2X3", "siteplacement")
    p2 = os.path.join(HERE, "edificio_site_ifc2x3.ifc")
    f2.write(p2)
    pd = os.path.join(HERE, "planta_georef.dxf")
    build_dxf(pd)
    corners = {name: local_to_map(x, y) for name, (x, y) in
               {"origen": (0, 0), "esq_x": (W, 0), "esq_xy": (W, D), "esq_y": (0, D)}.items()}
    out = {
        "crs": "EPSG:32718",
        "eastings": EASTINGS, "northings": NORTHINGS, "orthogonalHeight": HEIGHT,
        "rotationDeg": ROT_DEG,
        "buildingLocalSize": [W, D],
        "buildingCornersMap": corners,
        "elementsPerStorey": counts,
        "files": [os.path.basename(p) for p in (p4, p2, pd)],
        "note": "Los vértices de la huella del DXF (capa MUROS) coinciden con las esquinas exteriores de los muros IFC.",
    }
    with open(os.path.join(HERE, "fixtures.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
