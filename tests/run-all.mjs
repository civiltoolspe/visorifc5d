// Ejecuta en serie cada tests/e2e/*.test.mjs como proceso Node hijo y resume el resultado.
//
// Uso:
//   node tests/run-all.mjs              ejecuta todas las pruebas
//   node tests/run-all.mjs server       solo las que contengan "server" en el nombre
//   node tests/run-all.mjs ifc cad      varios filtros (se ejecutan las que coincidan con cualquiera)
//
// Termina con código 0 si todas pasan y con código distinto de 0 si alguna falla,
// se agota su tiempo (10 min) o no se encuentra ninguna prueba.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// E2E_DIR y E2E_TIMEOUT_MS permiten probar este ejecutor con otras carpetas y tiempos
const CARPETA = process.env.E2E_DIR ? path.resolve(process.env.E2E_DIR) : path.join(RAIZ, 'tests', 'e2e');
const TIEMPO_MAX_MS = Number(process.env.E2E_TIMEOUT_MS) || 10 * 60 * 1000;

const filtros = process.argv.slice(2).map((f) => f.toLowerCase());

const archivos = fs.readdirSync(CARPETA)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filtros.length || filtros.some((q) => f.toLowerCase().includes(q)))
  .sort();

if (!archivos.length) {
  console.error(filtros.length
    ? `No hay pruebas que coincidan con: ${filtros.join(', ')}`
    : 'No se encontraron pruebas en tests/e2e/*.test.mjs');
  process.exit(1);
}

// Mata el proceso hijo y todo lo que haya arrancado (p. ej. servidores de prueba).
function matarArbol(hijo) {
  if (hijo.exitCode !== null || !hijo.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-hijo.pid, 'SIGKILL'); // el hijo es líder de su propio grupo (detached)
    }
  } catch {
    try { hijo.kill('SIGKILL'); } catch { /* ya terminó */ }
  }
}

let actual = null;
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    if (actual) matarArbol(actual);
    process.exit(130);
  });
}

function ejecutar(archivo) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const hijo = spawn(process.execPath, [path.join(CARPETA, archivo)], {
      cwd: RAIZ,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    actual = hijo;
    let agotado = false;
    const temporizador = setTimeout(() => {
      agotado = true;
      console.error(`\n[run-all] ${archivo}: tiempo agotado (${Math.round(TIEMPO_MAX_MS / 1000)} s); se detiene.`);
      matarArbol(hijo);
    }, TIEMPO_MAX_MS);

    const terminar = (estado, detalle) => {
      clearTimeout(temporizador);
      actual = null;
      resolve({ archivo, estado, detalle, ms: Date.now() - t0 });
    };
    hijo.on('error', (err) => terminar('FAIL', `no se pudo ejecutar: ${err.message}`));
    hijo.on('exit', (code, senal) => {
      if (agotado) terminar('FAIL', 'tiempo agotado');
      else if (code === 0) terminar('PASS', '');
      else terminar('FAIL', senal ? `terminó por la señal ${senal}` : `código de salida ${code}`);
    });
  });
}

const resultados = [];
for (const archivo of archivos) {
  console.log(`\n==================== ${archivo} ====================`);
  const r = await ejecutar(archivo);
  resultados.push(r);
  console.log(`-------------------- ${archivo}: ${r.estado} (${(r.ms / 1000).toFixed(1)} s)${r.detalle ? ` - ${r.detalle}` : ''}`);
}

console.log('\n==================== RESUMEN ====================');
const ancho = Math.max(...resultados.map((r) => r.archivo.length));
for (const r of resultados) {
  console.log(`  ${r.estado}  ${r.archivo.padEnd(ancho)}  ${(r.ms / 1000).toFixed(1).padStart(6)} s${r.detalle ? `  (${r.detalle})` : ''}`);
}
const fallidas = resultados.filter((r) => r.estado !== 'PASS');
console.log(`\n  ${resultados.length - fallidas.length} de ${resultados.length} archivos de prueba pasaron.`);
process.exit(fallidas.length ? 1 : 0);
