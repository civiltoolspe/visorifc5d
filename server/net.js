// Utilidades de red: direcciones de la LAN y mensajes de arranque.
import os from 'node:os';

// Direcciones IPv4 no internas de esta PC (las que usarán las demás PCs).
// Se descartan las de enlace local (169.254.x.x, adaptadores sin configurar) y se
// listan primero las de redes domésticas/oficina (192.168.x.x, 10.x.x.x, 172.16-31.x.x).
export function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const lista of Object.values(ifaces)) {
    for (const nic of lista || []) {
      const v4 = nic.family === 'IPv4' || nic.family === 4;
      if (v4 && !nic.internal && !nic.address.startsWith('169.254.')) out.push(nic.address);
    }
  }
  const prioridad = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return out.sort((a, b) => prioridad(a) - prioridad(b));
}

export function lanUrls(port) {
  return lanAddresses().map((ip) => `http://${ip}:${port}`);
}

// Texto que se imprime al arrancar (en español).
export function bannerArranque({ port, host, version, dataDir, pinEnabled, viewerFreeNav, maxUploadMb, allowedHosts = [] }) {
  const urls = lanUrls(port);
  const l = [];
  l.push('');
  l.push(`  Visor IFC 5D v${version} - servidor iniciado`);
  l.push('');
  l.push('  Anfitrión / presentador (esta PC):');
  l.push(`    http://localhost:${port}`);
  l.push('');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    l.push(`  El servidor solo escucha en ${host}: las demás PCs NO podrán conectarse.`);
    l.push('  Para compartirlo en la red local arranca sin HOST o con HOST=0.0.0.0.');
  } else if (urls.length) {
    l.push('  Espectadores (otras PCs de la red local):');
    for (const u of urls) l.push(`    ${u}`);
  } else {
    l.push('  No se detectaron interfaces de red activas: las demás PCs no podrán conectarse.');
  }
  l.push('');
  l.push(`  Carpeta de datos:        ${dataDir}`);
  l.push(`  Tamaño máx. de subida:   ${formatMb(maxUploadMb)}`);
  l.push(`  PIN de presentador:      ${pinEnabled ? 'activado (otras PCs pueden presentar con el PIN)' : 'no definido (solo esta PC presenta)'}`);
  l.push(`  Navegación libre de espectadores sin presentación: ${viewerFreeNav ? 'sí' : 'no'}`);
  l.push(`  Nombres de host aceptados: IPs, localhost y el nombre de esta PC${allowedHosts.length ? `, más ${allowedHosts.join(', ')}` : ' (otros nombres: variable ALLOWED_HOSTS)'}`);
  l.push('');
  l.push('  Aviso (Windows): si las otras PCs no pueden abrir la dirección, el Firewall de');
  l.push(`  Windows probablemente bloquea el puerto ${port}. Abre PowerShell como administrador y ejecuta:`);
  l.push(`    netsh advfirewall firewall add rule name="Visor IFC 5D" dir=in action=allow protocol=TCP localport=${port}`);
  l.push('  (o permite "Node.js JavaScript Runtime" en red privada cuando Windows lo solicite).');
  l.push('');
  l.push('  Pulsa Ctrl+C para detener el servidor.');
  l.push('');
  return l.join('\n');
}

function formatMb(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}
