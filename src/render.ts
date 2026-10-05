import { DerNode } from './der/parser.js';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function valueSummary(node: DerNode): string {
  const v = node.interpretation;
  switch (v.kind) {
    case 'boolean':
      return v.value ? 'TRUE (FF)' : 'FALSE (00)';
    case 'integer':
      return v.withinSafeInteger
        ? `INTEGER ${v.decimal}`
        : `INTEGER ${v.decimal}  (超出安全整数范围)`;
    case 'null':
      return 'NULL';
    case 'octetString':
      return `OCTET STRING (${v.length} 字节) ${truncate(v.hex)}`;
    case 'bitString':
      return `BIT STRING 未用位=${v.unusedBits} 有效位=${v.effectiveBitLength} 数据=${truncate(v.dataHex)}`;
    case 'oid':
      return `OID ${v.dotted}`;
    case 'utf8':
      return `UTF8String ${JSON.stringify(v.text)}`;
    case 'sequence':
      return `SEQUENCE (${v.childCount} 个子节点)`;
  }
}

function truncate(hex: string): string {
  return hex.length > 48 ? `${hex.slice(0, 48)}…` : hex;
}

export function renderTree(root: DerNode): string {
  const lines: string[] = [];
  const width = String(root.end).length;
  const walk = (node: DerNode, depth: number): void => {
    const indent = '  '.repeat(depth);
    const range = `[${pad(node.start, width)}-${pad(node.end, width)})`;
    const header = `len=${node.valueLength} val@${pad(node.valueStart, width)}`;
    lines.push(`${indent}${range} ${node.tagName} ${header}  ${valueSummary(node)}`);
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}
