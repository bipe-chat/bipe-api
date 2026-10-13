const arities = { eq: 2, neq: 2, afterChange: 2, atOrBefore: 2 };
const unary = new Set(['not', 'nonempty', 'validTime', 'nullableTime']);

export function validateTrustRegistry(reg) {
  if (reg.version !== 1) throw new Error('trust-facts: version must be 1');
  const fields = Object.keys(reg.inputFields), rules = [];
  for (const [name, type] of Object.entries(reg.inputFields)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || !['string', 'boolean', 'time'].includes(type)) throw new Error('trust-facts: invalid input field');
  }
  const check = (node) => {
    if (node === null) return 'null';
    if (typeof node === 'string') {
      if (!/^[a-z][a-z0-9_]*$/.test(node)) throw new Error('trust-facts: literals must be state codes');
      return 'string';
    }
    if (typeof node === 'boolean') return 'boolean';
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1) throw new Error('trust-facts: invalid expression');
    const [op, value] = Object.entries(node)[0];
    if (op === 'field') { if (!fields.includes(value)) throw new Error('trust-facts: unknown field'); return reg.inputFields[value]; }
    if (op === 'rule') { if (!rules.includes(value)) throw new Error('trust-facts: forward or unknown rule'); return 'boolean'; }
    if (unary.has(op)) {
      const type = check(value), required = op === 'not' ? 'boolean' : op === 'nonempty' ? 'string' : 'time';
      if (type !== required) throw new Error('trust-facts: invalid operand type');
      return 'boolean';
    }
    if (op === 'all' || op === 'any' || op in arities) {
      if (!Array.isArray(value) || !value.length || (op in arities && value.length !== arities[op])) throw new Error('trust-facts: invalid arity');
      const types = value.map(check);
      if (op === 'all' || op === 'any') {
        if (types.some((type) => type !== 'boolean')) throw new Error('trust-facts: condition must be boolean');
      } else if (op === 'afterChange' || op === 'atOrBefore') {
        if (types.some((type) => type !== 'time')) throw new Error('trust-facts: timestamps required');
      } else if (types[0] !== types[1] && !types.includes('null')) throw new Error('trust-facts: mismatched comparison');
      return 'boolean';
    }
    throw new Error('trust-facts: unknown operator');
  };
  for (const [name, expr] of Object.entries(reg.rules)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || fields.includes(name)) throw new Error('trust-facts: invalid rule name');
    if (check(expr) !== 'boolean') throw new Error('trust-facts: rule must be boolean');
    rules.push(name);
  }
  if (Object.keys(reg.outputs).sort().join() !== 'change,contact,identity,verifiedName,warningKind') throw new Error('trust-facts: output fields');
  for (const [name, output] of Object.entries(reg.outputs)) {
    if (!Array.isArray(output.choose) || !output.choose.length || !Object.hasOwn(output, 'else')) throw new Error('trust-facts: invalid output');
    const nullable = ['verifiedName', 'warningKind'].includes(name);
    const checkValue = (value) => { const type = check(value); if (type !== 'string' && !(nullable && type === 'null')) throw new Error('trust-facts: output must be a string'); };
    for (const branch of output.choose) {
      if (check(branch.when) !== 'boolean') throw new Error('trust-facts: output condition must be boolean');
      checkValue(branch.value);
    }
    checkValue(output.else);
  }
}

export function evaluateTrustFacts(input, registry) {
  const rules = {};
  const validTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const evaluate = (node) => {
    if (node === null || typeof node !== 'object') return node;
    const [op, value] = Object.entries(node)[0];
    if (op === 'field') return input[value] ?? null;
    if (op === 'rule') return rules[value];
    if (op === 'all') return value.every(evaluate);
    if (op === 'any') return value.some(evaluate);
    if (op === 'not') return !evaluate(value);
    if (op === 'nonempty') { const v = evaluate(value); return typeof v === 'string' && v.length > 0; }
    if (op === 'validTime') return validTime(evaluate(value));
    if (op === 'nullableTime') { const v = evaluate(value); return v === null || validTime(v); }
    const [a, b] = value.map(evaluate);
    if (op === 'eq') return a === b;
    if (op === 'neq') return a !== b;
    if (op === 'afterChange') return validTime(a) && (b === null || (validTime(b) && a > b));
    if (op === 'atOrBefore') return validTime(a) && validTime(b) && a <= b;
    throw new Error('trust-facts: unknown operator');
  };
  for (const [name, expr] of Object.entries(registry.rules)) rules[name] = evaluate(expr);
  return Object.fromEntries(Object.entries(registry.outputs).map(([key, output]) => {
    const branch = output.choose.find((candidate) => evaluate(candidate.when));
    return [key, evaluate(branch ? branch.value : output.else)];
  }));
}
