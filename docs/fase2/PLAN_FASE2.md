# Fase 2 — Plan y estado de traspaso

Estado al detener el trabajo en la nube (2026-10-13). La fase 2 **no está implementada todavía**:
este documento recoge las decisiones tomadas, lo investigado y lo pendiente para continuar en local.

## Objetivo

Mostrar el avance de proyectos modelados en Revit (RVT → IFC) con seguimiento 4D/5D:
avance, costo y tiempo de ejecución por partida, para **varios proyectos**.
Entregar además las reglas de modelado para el modelador BIM, los parámetros compartidos
y un complemento de Revit (DLL) que los cree.

## Decisiones tomadas

- **Revit 2027 → .NET 10** (`net10.0-windows`). Referencias de la API: paquetes NuGet
  `Nice3point.Revit.Api.RevitAPI` / `RevitAPIUI` versión `2027.x`. En Windows se compila con
  `dotnet build` (SDK de .NET 10) o Visual Studio. Manifiesto `.addin` en
  `%AppData%\Autodesk\Revit\Addins\2027\`.
- **El vínculo central es el código de partida.** Las partidas del presupuesto son fijas;
  los cronogramas cambian. Por eso:
  - cada elemento del modelo lleva los códigos de sus partidas (parámetros compartidos);
  - cada tarea del cronograma de MS Project lleva el código de partida (campo de texto, p. ej. Texto1);
  - al importar una nueva versión del cronograma, los vínculos se conservan.
- Un elemento estructural tiene normalmente **varias partidas** (concreto m³, encofrado m², acero kg).
- El visor busca las propiedades por **nombre en cualquier Pset**, sin depender del nombre del
  conjunto de propiedades (que Revit cambia según idioma y configuración).
- El repositorio `civiltoolspe/visorifc5d` es **público**: el expediente del proyecto
  (IFC reales, presupuesto, cronogramas) **no se sube aquí**.

## Propuesta de parámetros compartidos (borrador, por validar)

Prefijo `V5D_` para evitar choques con otros parámetros.

| Parámetro | Tipo | Uso |
|---|---|---|
| `V5D_Proyecto` | Texto | Código del proyecto (multiproyecto) |
| `V5D_Bloque` | Texto | Bloque / módulo |
| `V5D_Sector` | Texto | Frente o sector de trabajo (vincula con tareas por sector) |
| `V5D_Nivel` | Texto | Nivel de obra (además del nivel de Revit) |
| `V5D_Especialidad` | Texto | Estructuras, Arquitectura, IISS, IIEE |
| `V5D_Partida_Concreto` | Texto | Código de partida de concreto |
| `V5D_Partida_Encofrado` | Texto | Código de partida de encofrado |
| `V5D_Partida_Acero` | Texto | Código de partida de acero |
| `V5D_Partidas_Otras` | Texto | Otros códigos separados por `;` |
| `V5D_Area_Encofrado` | Área | Metrado de encofrado del elemento |
| `V5D_Peso_Acero` | Número (kg) | Metrado de acero del elemento |
| `V5D_Estado` | Texto | Opcional: Pendiente / En ejecución / Ejecutado |
| `V5D_Fecha_Ejecucion` | Texto (AAAA-MM-DD) | Opcional |
| `V5D_Avance` | Número (0–100) | Opcional |

El volumen de concreto se toma de las cantidades base del IFC (NetVolume / Volumen de Revit).

## Pendiente

1. **Bloques que no se visualizan** (IFC de módulos vinculados). No se pudo reproducir sin el archivo.
   Hipótesis a comprobar con los IFC reales de `data\uploads`:
   - IFC en **milímetros** colocado mal (ancla o matriz de coordinación sin escalar);
   - **doble georreferencia**: coordenadas grandes en `IfcSite` **y** `IfcMapConversion` aplicada
     encima → el modelo queda a cientos de km (otros visores ignoran IfcMapConversion);
   - tipos ocultos por error (p. ej. bloques exportados como `IfcSpace` o proxys).
   Comparar contra ifcopenshell (coordenadas de mundo por colocaciones). Añadir un aviso cuando un
   modelo quede a más de 5 km de los demás y una herramienta `npm run diagnostico -- archivo.ifc`.
2. **Manual de reglas de modelado BIM** para el modelador (niveles, nomenclatura, parámetros,
   exportación IFC desde Revit 2027: cantidades base, Psets de usuario, vínculos como IFC
   separados, coordenadas compartidas).
3. **Archivo de parámetros compartidos** (`.txt`, GUID fijos) y **archivo de Psets de usuario**
   del exportador IFC de Revit que agrupe los `V5D_*` en un Pset fijo.
4. **Complemento de Revit 2027 (.NET 10)**: crear y vincular los parámetros a las categorías
   estructurales (columnas, vigas, cimentaciones, losas, muros, escaleras), asignar partidas a la
   selección desde una lista de partidas y validar el modelo.
5. **Visor fase 2**: multiproyecto, importación de partidas (Excel/CSV de S10) y de cronogramas
   (MS Project XML) con versiones, registro de avance por elemento, coloreado 4D por fecha con línea
   de tiempo, curva S programada vs ejecutada, valorizado en S/., panel de partidas y control de
   calidad BIM (elementos sin parámetros, códigos inexistentes, partidas sin elementos).

## Material de apoyo

- `docs/fase2/diseno-servidor-multiproyecto.md`: diseño de menor riesgo para multiproyecto y
  almacenamiento/API de datos 5D en el servidor, con las pruebas existentes que podrían romperse.
- `docs/ARQUITECTURA.md`: contrato de módulos de la fase 1.
- Los ganchos ya existentes para la fase 2: `ifc.findByGlobalId()` y `ifc.setElementColors()`.
