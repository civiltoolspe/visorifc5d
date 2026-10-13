// Limpieza de textos CAD: códigos de formato MTEXT y códigos especiales de TEXT (%%c, %%d...).
// Módulo puro, importable desde Node y desde Web Workers.

// Códigos "%%" de TEXT/MTEXT. Los conmutadores (subrayado, sobrerrayado, tachado) se descartan.
function replacePercentCodes(s) {
  return s.replace(/%%([cCdDpP%uUoOkK]|\d{3})/g, (_m, code) => {
    const c = code.toLowerCase();
    if (c === 'c') return 'Ø';
    if (c === 'd') return '°';
    if (c === 'p') return '±';
    if (c === '%') return '%';
    if (c === 'u' || c === 'o' || c === 'k') return '';
    return String.fromCharCode(parseInt(code, 10));
  });
}

// \U+00E1 → á
function replaceUnicodeEscapes(s) {
  return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Texto simple (TEXT / ATTRIB): una sola línea.
export function cleanPlainText(raw) {
  if (raw === undefined || raw === null) return '';
  let s = String(raw);
  s = replaceUnicodeEscapes(s);
  s = replacePercentCodes(s);
  return s.replace(/[\r\n]+/g, ' ');
}

// Interpreta una fracción apilada de MTEXT (\S1/2; \S1^2; \S1#2;)
function stackedText(body) {
  const m = /^([^/^#]*)([/^#])(.*)$/.exec(body);
  if (!m) return body;
  const [, num, sep, den] = m;
  if (sep === '^') return `${num} ${den}`.trim();
  return `${num}/${den}`;
}

// Texto multilínea (MTEXT): quita códigos de formato y devuelve las líneas.
//   \P salto de párrafo, {\fArial|b1;texto} fuentes, \A1; alineación, \H2.5; altura,
//   \W0.8; ancho, \C1; color, \L \O \K subrayado/sobrerrayado/tachado, \~ espacio duro,
//   \S1/2; fracciones, \U+XXXX unicode, llaves de agrupación.
export function parseMtext(raw) {
  if (raw === undefined || raw === null) return { text: '', lines: [''] };
  const src = replaceUnicodeEscapes(String(raw));
  let out = '';
  const len = src.length;
  let i = 0;
  while (i < len) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) {
        i++;
        continue;
      }
      switch (n) {
        case 'P':
        case 'p':
        case 'N':
          out += '\n';
          i += 2;
          break;
        case '~':
          out += ' ';
          i += 2;
          break;
        case '\\':
        case '{':
        case '}':
          out += n;
          i += 2;
          break;
        case 'L':
        case 'l':
        case 'O':
        case 'o':
        case 'K':
        case 'k':
          i += 2;
          break;
        case 'S': {
          const end = src.indexOf(';', i + 2);
          if (end < 0) {
            i += 2;
          } else {
            out += stackedText(src.slice(i + 2, end));
            i = end + 1;
          }
          break;
        }
        case 'F':
        case 'f':
        case 'C':
        case 'c':
        case 'H':
        case 'h':
        case 'W':
        case 'w':
        case 'Q':
        case 'q':
        case 'T':
        case 't':
        case 'A':
        case 'a':
        case 'M':
        case 'm':
        case 'X': {
          const end = src.indexOf(';', i + 2);
          i = end < 0 ? i + 2 : end + 1;
          break;
        }
        default:
          out += n;
          i += 2;
      }
    } else if (c === '{' || c === '}') {
      i++;
    } else if (c === '%' && src[i + 1] === '%') {
      const m = /^%%([cCdDpP%uUoOkK]|\d{3})/.exec(src.slice(i, i + 5));
      if (m) {
        out += replacePercentCodes(m[0]);
        i += m[0].length;
      } else {
        out += c;
        i++;
      }
    } else if (c === '\r') {
      i++;
    } else {
      out += c;
      i++;
    }
  }
  const lines = out.split('\n');
  return { text: out, lines };
}
