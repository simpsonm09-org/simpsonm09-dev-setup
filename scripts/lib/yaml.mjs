// A block-only YAML subset: mappings, sequences, and scalars. Plain node, no
// dependencies. Extracted from scripts/tools.mjs so the generator stays small.
//
// Supported: block mappings, block sequences, quoted and plain scalars, booleans,
// null, integers, floats, and comments. Not supported: flow collections, anchors,
// multi-line scalars, and nested sequences of sequences.

// A quote opens a scalar only at a scalar boundary. An apostrophe inside a plain
// scalar, as in `don't`, is literal and must not start a quoted run.
function opensQuote(line, index) {
  if (index === 0) return true;
  const previous = line[index - 1];
  return previous === ' ' || previous === '\t' || previous === ':' || previous === '-'
    || previous === '[' || previous === '{' || previous === ',';
}

export function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) {
        if (quote === "'" && line[index + 1] === "'") { index += 1; continue; }
        quote = null;
      }
      continue;
    }
    if ((char === "'" || char === '"') && opensQuote(line, index)) {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function keyColon(text) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === ':' && !inSingle && !inDouble) {
      if (index === text.length - 1 || text[index + 1] === ' ') return index;
    }
  }
  return -1;
}

function splitKey(text) {
  const index = keyColon(text);
  if (index === -1) throw new Error(`not a mapping entry: ${text}`);
  return { key: text.slice(0, index).trim(), rest: text.slice(index + 1).trim() };
}

function parseScalar(text) {
  const value = text.trim();
  if (value === '' || value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function parseMapping(lines, index, indent) {
  const result = {};
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) break;
    if (line.text.startsWith('- ') || line.text === '-') break;
    const { key, rest } = splitKey(line.text);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`duplicate key "${key}"`);
    cursor += 1;
    if (rest !== '') {
      result[key] = parseScalar(rest);
    } else if (cursor < lines.length && lines[cursor].indent > indent) {
      [result[key], cursor] = parseNode(lines, cursor, lines[cursor].indent);
    } else if (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].text.startsWith('- ')) {
      [result[key], cursor] = parseSequence(lines, cursor, indent);
    } else {
      result[key] = null;
    }
  }
  return [result, cursor];
}

function parseSequence(lines, index, indent) {
  const result = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) break;
    if (!(line.text.startsWith('- ') || line.text === '-')) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      cursor += 1;
      if (cursor < lines.length && lines[cursor].indent > indent) {
        let value;
        [value, cursor] = parseNode(lines, cursor, lines[cursor].indent);
        result.push(value);
      } else {
        result.push(null);
      }
    } else if (keyColon(rest) !== -1) {
      lines[cursor] = { indent: indent + 2, text: rest };
      let value;
      [value, cursor] = parseMapping(lines, cursor, indent + 2);
      result.push(value);
    } else {
      result.push(parseScalar(rest));
      cursor += 1;
    }
  }
  return [result, cursor];
}

function parseNode(lines, index, indent) {
  if (index >= lines.length) return [null, index];
  if (lines[index].text.startsWith('- ') || lines[index].text === '-') {
    return parseSequence(lines, index, indent);
  }
  return parseMapping(lines, index, indent);
}

export function parseYaml(text) {
  const lines = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const stripped = stripComment(raw);
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  if (lines.length === 0) return null;
  return parseNode(lines, 0, lines[0].indent)[0];
}
