// Nombres legibles en español para los tipos IFC más comunes.
//
// typeLabel('IFCWALL')        -> 'Muro'     (singular, para un elemento)
// typeLabelPlural('IFCWALL')  -> 'Muros'    (plural, para categorías y resúmenes)
//
// Los tipos desconocidos usan un respaldo legible: se quita el prefijo IFC y se
// intenta separar las palabras en inglés ("IFCFLOWSEGMENT" -> "Flow Segment").

// [singular, plural]
const LABELS = {
  // Arquitectura / estructura
  IFCWALL: ['Muro', 'Muros'],
  IFCWALLSTANDARDCASE: ['Muro', 'Muros'],
  IFCWALLELEMENTEDCASE: ['Muro', 'Muros'],
  IFCSLAB: ['Losa', 'Losas'],
  IFCSLABSTANDARDCASE: ['Losa', 'Losas'],
  IFCSLABELEMENTEDCASE: ['Losa', 'Losas'],
  IFCCOLUMN: ['Columna', 'Columnas'],
  IFCCOLUMNSTANDARDCASE: ['Columna', 'Columnas'],
  IFCBEAM: ['Viga', 'Vigas'],
  IFCBEAMSTANDARDCASE: ['Viga', 'Vigas'],
  IFCMEMBER: ['Miembro estructural', 'Miembros estructurales'],
  IFCMEMBERSTANDARDCASE: ['Miembro estructural', 'Miembros estructurales'],
  IFCPLATE: ['Placa', 'Placas'],
  IFCPLATESTANDARDCASE: ['Placa', 'Placas'],
  IFCDOOR: ['Puerta', 'Puertas'],
  IFCDOORSTANDARDCASE: ['Puerta', 'Puertas'],
  IFCWINDOW: ['Ventana', 'Ventanas'],
  IFCWINDOWSTANDARDCASE: ['Ventana', 'Ventanas'],
  IFCSTAIR: ['Escalera', 'Escaleras'],
  IFCSTAIRFLIGHT: ['Tramo de escalera', 'Tramos de escalera'],
  IFCRAMP: ['Rampa', 'Rampas'],
  IFCRAMPFLIGHT: ['Tramo de rampa', 'Tramos de rampa'],
  IFCRAILING: ['Baranda', 'Barandas'],
  IFCROOF: ['Techo', 'Techos'],
  IFCCURTAINWALL: ['Muro cortina', 'Muros cortina'],
  IFCCOVERING: ['Acabado', 'Acabados'],
  IFCFOOTING: ['Zapata', 'Zapatas'],
  IFCPILE: ['Pilote', 'Pilotes'],
  IFCCHIMNEY: ['Chimenea', 'Chimeneas'],
  IFCSHADINGDEVICE: ['Dispositivo de sombra', 'Dispositivos de sombra'],
  IFCBUILDINGELEMENTPART: ['Parte de elemento', 'Partes de elemento'],
  IFCBUILDINGELEMENTPROXY: ['Elemento genérico', 'Elementos genéricos'],
  IFCELEMENTASSEMBLY: ['Ensamblaje', 'Ensamblajes'],
  IFCDISCRETEACCESSORY: ['Accesorio', 'Accesorios'],
  IFCMECHANICALFASTENER: ['Elemento de fijación', 'Elementos de fijación'],
  IFCFASTENER: ['Elemento de fijación', 'Elementos de fijación'],
  IFCREINFORCINGBAR: ['Barra de refuerzo', 'Barras de refuerzo'],
  IFCREINFORCINGMESH: ['Malla de refuerzo', 'Mallas de refuerzo'],
  IFCTENDON: ['Tendón', 'Tendones'],
  IFCTENDONANCHOR: ['Anclaje de tendón', 'Anclajes de tendón'],
  IFCOPENINGELEMENT: ['Vano', 'Vanos'],
  IFCOPENINGSTANDARDCASE: ['Vano', 'Vanos'],
  IFCVIRTUALELEMENT: ['Elemento virtual', 'Elementos virtuales'],
  IFCCIVILELEMENT: ['Elemento civil', 'Elementos civiles'],
  IFCGEOGRAPHICELEMENT: ['Elemento geográfico', 'Elementos geográficos'],
  IFCTRANSPORTELEMENT: ['Elemento de transporte', 'Elementos de transporte'],
  IFCBEARING: ['Apoyo', 'Apoyos'],
  IFCKERB: ['Bordillo', 'Bordillos'],
  IFCPAVEMENT: ['Pavimento', 'Pavimentos'],
  IFCRAIL: ['Riel', 'Rieles'],
  IFCEARTHWORKSELEMENT: ['Movimiento de tierras', 'Movimientos de tierras'],
  IFCSIGN: ['Señal', 'Señales'],
  IFCSIGNAL: ['Señal luminosa', 'Señales luminosas'],

  // Mobiliario
  IFCFURNISHINGELEMENT: ['Mobiliario', 'Mobiliario'],
  IFCFURNITURE: ['Mueble', 'Muebles'],
  IFCSYSTEMFURNITUREELEMENT: ['Mobiliario de sistema', 'Mobiliario de sistema'],

  // Estructura espacial
  IFCPROJECT: ['Proyecto', 'Proyectos'],
  IFCSITE: ['Terreno', 'Terrenos'],
  IFCBUILDING: ['Edificio', 'Edificios'],
  IFCBUILDINGSTOREY: ['Nivel', 'Niveles'],
  IFCSPACE: ['Espacio', 'Espacios'],
  IFCFACILITY: ['Instalación', 'Instalaciones'],
  IFCFACILITYPART: ['Parte de instalación', 'Partes de instalación'],
  IFCBRIDGE: ['Puente', 'Puentes'],
  IFCROAD: ['Vía', 'Vías'],
  IFCGRID: ['Retícula', 'Retículas'],
  IFCANNOTATION: ['Anotación', 'Anotaciones'],

  // MEP genéricos
  IFCDISTRIBUTIONELEMENT: ['Elemento de distribución', 'Elementos de distribución'],
  IFCDISTRIBUTIONFLOWELEMENT: ['Elemento de flujo', 'Elementos de flujo'],
  IFCDISTRIBUTIONCONTROLELEMENT: ['Elemento de control', 'Elementos de control'],
  IFCDISTRIBUTIONCHAMBERELEMENT: ['Cámara de distribución', 'Cámaras de distribución'],
  IFCFLOWSEGMENT: ['Segmento de flujo', 'Segmentos de flujo'],
  IFCFLOWFITTING: ['Accesorio de flujo', 'Accesorios de flujo'],
  IFCFLOWTERMINAL: ['Terminal de flujo', 'Terminales de flujo'],
  IFCFLOWCONTROLLER: ['Controlador de flujo', 'Controladores de flujo'],
  IFCFLOWMOVINGDEVICE: ['Dispositivo de impulsión', 'Dispositivos de impulsión'],
  IFCFLOWSTORAGEDEVICE: ['Dispositivo de almacenamiento', 'Dispositivos de almacenamiento'],
  IFCFLOWTREATMENTDEVICE: ['Dispositivo de tratamiento', 'Dispositivos de tratamiento'],
  IFCFLOWMETER: ['Medidor', 'Medidores'],
  IFCENERGYCONVERSIONDEVICE: ['Dispositivo de conversión de energía', 'Dispositivos de conversión de energía'],

  // Tuberías y ductos
  IFCPIPESEGMENT: ['Tubería', 'Tuberías'],
  IFCPIPEFITTING: ['Accesorio de tubería', 'Accesorios de tubería'],
  IFCDUCTSEGMENT: ['Ducto', 'Ductos'],
  IFCDUCTFITTING: ['Accesorio de ducto', 'Accesorios de ducto'],
  IFCDUCTSILENCER: ['Silenciador de ducto', 'Silenciadores de ducto'],
  IFCCABLECARRIERSEGMENT: ['Bandeja portacables', 'Bandejas portacables'],
  IFCCABLECARRIERFITTING: ['Accesorio de bandeja', 'Accesorios de bandeja'],
  IFCCABLESEGMENT: ['Cable', 'Cables'],
  IFCCABLEFITTING: ['Accesorio de cable', 'Accesorios de cable'],
  IFCVALVE: ['Válvula', 'Válvulas'],
  IFCDAMPER: ['Compuerta', 'Compuertas'],
  IFCPUMP: ['Bomba', 'Bombas'],
  IFCFAN: ['Ventilador', 'Ventiladores'],
  IFCCOMPRESSOR: ['Compresor', 'Compresores'],
  IFCBOILER: ['Caldera', 'Calderas'],
  IFCCHILLER: ['Enfriadora', 'Enfriadoras'],
  IFCCONDENSER: ['Condensador', 'Condensadores'],
  IFCCOIL: ['Serpentín', 'Serpentines'],
  IFCCOOLINGTOWER: ['Torre de enfriamiento', 'Torres de enfriamiento'],
  IFCHEATEXCHANGER: ['Intercambiador de calor', 'Intercambiadores de calor'],
  IFCEVAPORATOR: ['Evaporador', 'Evaporadores'],
  IFCEVAPORATIVECOOLER: ['Enfriador evaporativo', 'Enfriadores evaporativos'],
  IFCHUMIDIFIER: ['Humidificador', 'Humidificadores'],
  IFCSPACEHEATER: ['Calefactor', 'Calefactores'],
  IFCTANK: ['Tanque', 'Tanques'],
  IFCFILTER: ['Filtro', 'Filtros'],
  IFCINTERCEPTOR: ['Interceptor', 'Interceptores'],
  IFCSANITARYTERMINAL: ['Aparato sanitario', 'Aparatos sanitarios'],
  IFCWASTETERMINAL: ['Desagüe', 'Desagües'],
  IFCSTACKTERMINAL: ['Terminal de bajante', 'Terminales de bajante'],
  IFCAIRTERMINAL: ['Terminal de aire', 'Terminales de aire'],
  IFCAIRTERMINALBOX: ['Caja de aire', 'Cajas de aire'],
  IFCAIRTOAIRHEATRECOVERY: ['Recuperador de calor', 'Recuperadores de calor'],
  IFCUNITARYEQUIPMENT: ['Equipo unitario', 'Equipos unitarios'],
  IFCFIRESUPPRESSIONTERMINAL: ['Rociador / terminal contra incendios', 'Rociadores / terminales contra incendios'],
  IFCMEDICALDEVICE: ['Dispositivo médico', 'Dispositivos médicos'],

  // Eléctrico y comunicaciones
  IFCLIGHTFIXTURE: ['Luminaria', 'Luminarias'],
  IFCLAMP: ['Lámpara', 'Lámparas'],
  IFCELECTRICAPPLIANCE: ['Artefacto eléctrico', 'Artefactos eléctricos'],
  IFCELECTRICDISTRIBUTIONBOARD: ['Tablero eléctrico', 'Tableros eléctricos'],
  IFCELECTRICFLOWSTORAGEDEVICE: ['Almacenamiento eléctrico', 'Almacenamientos eléctricos'],
  IFCELECTRICGENERATOR: ['Generador eléctrico', 'Generadores eléctricos'],
  IFCELECTRICMOTOR: ['Motor eléctrico', 'Motores eléctricos'],
  IFCELECTRICTIMECONTROL: ['Control horario', 'Controles horarios'],
  IFCMOTORCONNECTION: ['Conexión de motor', 'Conexiones de motor'],
  IFCTRANSFORMER: ['Transformador', 'Transformadores'],
  IFCOUTLET: ['Tomacorriente', 'Tomacorrientes'],
  IFCSWITCHINGDEVICE: ['Interruptor', 'Interruptores'],
  IFCPROTECTIVEDEVICE: ['Dispositivo de protección', 'Dispositivos de protección'],
  IFCPROTECTIVEDEVICETRIPPINGUNIT: ['Unidad de disparo', 'Unidades de disparo'],
  IFCJUNCTIONBOX: ['Caja de paso', 'Cajas de paso'],
  IFCCOMMUNICATIONSAPPLIANCE: ['Equipo de comunicaciones', 'Equipos de comunicaciones'],
  IFCAUDIOVISUALAPPLIANCE: ['Equipo audiovisual', 'Equipos audiovisuales'],
  IFCSENSOR: ['Sensor', 'Sensores'],
  IFCACTUATOR: ['Actuador', 'Actuadores'],
  IFCALARM: ['Alarma', 'Alarmas'],
  IFCCONTROLLER: ['Controlador', 'Controladores'],
  IFCUNITARYCONTROLELEMENT: ['Elemento de control unitario', 'Elementos de control unitarios'],
  IFCSOLARDEVICE: ['Dispositivo solar', 'Dispositivos solares'],
};

// Diccionario de palabras para el respaldo (separar nombres IFC largos).
const WORDS = [
  'access', 'accessory', 'actuator', 'air', 'alarm', 'alignment', 'annotation', 'appliance', 'assembly', 'audio',
  'bar', 'beam', 'bearing', 'boiler', 'box', 'bridge', 'building', 'cable', 'carrier', 'case', 'chamber', 'chiller',
  'chimney', 'civil', 'coil', 'column', 'communications', 'compressor', 'condenser', 'connection', 'control',
  'controller', 'conversion', 'cooling', 'covering', 'curtain', 'damper', 'device', 'discrete', 'distribution',
  'door', 'duct', 'earthworks', 'electric', 'element', 'elemented', 'energy', 'equipment', 'evaporator', 'exchanger',
  'fan', 'fastener', 'filter', 'fire', 'fitting', 'fixture', 'flight', 'flow', 'footing', 'furnishing', 'furniture',
  'generator', 'geographic', 'grid', 'heat', 'interceptor', 'junction', 'kerb', 'lamp', 'light', 'mechanical',
  'medical', 'member', 'mesh', 'meter', 'motor', 'moving', 'opening', 'outlet', 'part', 'pavement', 'pile', 'pipe',
  'plate', 'project', 'protective', 'proxy', 'pump', 'rail', 'railing', 'ramp', 'reinforcing', 'road', 'roof',
  'sanitary', 'segment', 'sensor', 'shading', 'sign', 'signal', 'silencer', 'site', 'slab', 'solar', 'space',
  'stack', 'stair', 'standard', 'storage', 'storey', 'suppression', 'switching', 'system', 'tank', 'tendon',
  'terminal', 'tower', 'transformer', 'transport', 'treatment', 'unit', 'unitary', 'valve', 'virtual', 'visual',
  'waste', 'wall', 'window',
];
const WORD_SET = new Set(WORDS);

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Intenta partir 'flowsegment' en palabras conocidas (programación dinámica, menos palabras = mejor).
function segment(lower) {
  const n = lower.length;
  const best = new Array(n + 1).fill(null);
  best[0] = [];
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 14); j < i; j++) {
      if (!best[j]) continue;
      const w = lower.slice(j, i);
      if (!WORD_SET.has(w)) continue;
      const cand = [...best[j], w];
      if (!best[i] || cand.length < best[i].length) best[i] = cand;
    }
  }
  return best[n];
}

// Respaldo legible para tipos sin traducción.
export function humanizeIfcType(type) {
  const raw = String(type || '').toUpperCase();
  const base = raw.startsWith('IFC') ? raw.slice(3) : raw;
  if (!base) return 'Elemento';
  const lower = base.toLowerCase();
  const words = segment(lower);
  if (words && words.length) return words.map(capitalize).join(' ');
  return capitalize(lower);
}

function normalizeType(type) {
  return String(type || '').toUpperCase();
}

// Etiqueta en singular ('Muro').
export function typeLabel(type) {
  const t = normalizeType(type);
  return LABELS[t] ? LABELS[t][0] : humanizeIfcType(t);
}

// Etiqueta en plural ('Muros').
export function typeLabelPlural(type) {
  const t = normalizeType(type);
  if (LABELS[t]) return LABELS[t][1];
  const h = humanizeIfcType(t);
  return h;
}

export function hasTypeLabel(type) {
  return !!LABELS[normalizeType(type)];
}

export const TYPE_LABELS = LABELS;

// Variantes "standard case" / "elemented case" que se agrupan con su clase base en categorías y filtros.
const CATEGORY_BASE = {
  IFCWALLSTANDARDCASE: 'IFCWALL',
  IFCWALLELEMENTEDCASE: 'IFCWALL',
  IFCSLABSTANDARDCASE: 'IFCSLAB',
  IFCSLABELEMENTEDCASE: 'IFCSLAB',
  IFCBEAMSTANDARDCASE: 'IFCBEAM',
  IFCCOLUMNSTANDARDCASE: 'IFCCOLUMN',
  IFCDOORSTANDARDCASE: 'IFCDOOR',
  IFCWINDOWSTANDARDCASE: 'IFCWINDOW',
  IFCMEMBERSTANDARDCASE: 'IFCMEMBER',
  IFCPLATESTANDARDCASE: 'IFCPLATE',
  IFCOPENINGSTANDARDCASE: 'IFCOPENINGELEMENT',
};

// Tipo de categoría de un tipo IFC (IFCWALLSTANDARDCASE -> IFCWALL; el resto se devuelve igual).
export function categoryType(type) {
  const t = normalizeType(type);
  return CATEGORY_BASE[t] || t;
}
