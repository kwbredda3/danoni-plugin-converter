// 構文木を歩いて、名前の参照を集める（どの宣言を指すか・関数の中か外か）
//
// acorn の構文木をそのまま使う。歩きながら、各ノードに _p（親）を付ける。
// 参照 1 つは { name, node, scope, shorthand }。あとで resolve() が、宣言のある場所（スコープ）と、
// そこから参照までの間に「あとで呼ばれる関数」がいくつ挟まるか（depth）を返す。
// depth が 0 の参照は、ファイルを読み込んだときに 1 回だけ読まれる。

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** その場で呼ばれる配列の関数（渡した関数は、読み込みの流れの中で動く） */
const SYNC_METHODS = new Set(['forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex',
    'findLast', 'findLastIndex', 'flatMap', 'sort', 'toSorted']);

export const isFunction = n => n !== null && typeof n === 'object'
    && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

class Scope {
    constructor(parent, boundary) {
        this.parent = parent;
        /** あとで呼ばれる関数の境目か（その場で呼ばれる関数は false） */
        this.boundary = boundary;
        this.names = new Set();
    }
}

/** 束縛のパターンから、名前を集める */
const patternNames = (p, out) => {
    switch (p?.type) {
        case 'Identifier': out.add(p.name); break;
        case 'ObjectPattern': p.properties.forEach(q => patternNames(q.type === 'RestElement' ? q.argument : q.value, out)); break;
        case 'ArrayPattern': p.elements.forEach(q => q && patternNames(q, out)); break;
        case 'AssignmentPattern': patternNames(p.left, out); break;
        case 'RestElement': patternNames(p.argument, out); break;
        default: break;
    }
};

const children = node => {
    const out = [];
    for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key) || key.startsWith('_')) continue;
        const v = node[key];
        if (Array.isArray(v)) {
            v.forEach(c => c && typeof c.type === 'string' && out.push(c));
        } else if (v && typeof v.type === 'string') {
            out.push(v);
        }
    }
    return out;
};

/** var の宣言を集める（関数の中へは入らない） */
const collectVars = (node, out) => {
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        node.declarations.forEach(d => patternNames(d.id, out));
    }
    for (const c of children(node)) {
        if (!isFunction(c)) collectVars(c, out);
    }
};

/** 文の並びの直下にある let・const・function・class の名前 */
const lexicalNames = (statements, out) => {
    for (const s of statements) {
        if (s.type === 'VariableDeclaration' && s.kind !== 'var') {
            s.declarations.forEach(d => patternNames(d.id, out));
        } else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) {
            out.add(s.id.name);
        }
    }
};

/**
 * 構文木を歩く
 * @returns {{ refs: object[], idents: Set<string>, programScope: Scope }}
 *   refs … 参照の一覧 / idents … ファイルに出てくる識別子の名前すべて（新しい名前がぶつからないか確かめる用）
 */
export const walkProgram = ast => {
    const refs = [];
    const idents = new Set();

    const visitBinding = (p, scope, parent) => {
        if (!p) return;
        p._p = parent;
        switch (p.type) {
            case 'Identifier': idents.add(p.name); break;
            case 'ObjectPattern':
                for (const q of p.properties) {
                    q._p = p;
                    if (q.type === 'RestElement') {
                        visitBinding(q.argument, scope, q);
                    } else {
                        if (q.computed) visit(q.key, scope, q);
                        visitBinding(q.value, scope, q);
                    }
                }
                break;
            case 'ArrayPattern': p.elements.forEach(q => visitBinding(q, scope, p)); break;
            case 'AssignmentPattern': visitBinding(p.left, scope, p); visit(p.right, scope, p); break;
            case 'RestElement': visitBinding(p.argument, scope, p); break;
            default: visit(p, scope, parent); break;
        }
    };

    const visitFunction = (node, scope) => {
        const s = new Scope(scope, node._immediate !== true);
        node._scope = s;
        if (node.type === 'FunctionExpression' && node.id) s.names.add(node.id.name);
        if (node.id) idents.add(node.id.name);
        if (node.type !== 'ArrowFunctionExpression') s.names.add('arguments');
        node.params.forEach(p => patternNames(p, s.names));
        node.params.forEach(p => visitBinding(p, s, node));
        if (node.body.type === 'BlockStatement') {
            collectVars(node.body, s.names);
            lexicalNames(node.body.body, s.names);
            node.body._p = node;
            node.body._scope = s;
            node.body.body.forEach(c => visit(c, s, node.body));
        } else {
            visit(node.body, s, node);
        }
    };

    const visit = (node, scope, parent) => {
        if (!node) return;
        node._p = parent;
        switch (node.type) {
            case 'Identifier':
                idents.add(node.name);
                refs.push({ name: node.name, node, scope, shorthand: false });
                return;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'ArrowFunctionExpression':
                visitFunction(node, scope);
                return;
            case 'BlockStatement': {
                const s = new Scope(scope, false);
                lexicalNames(node.body, s.names);
                node.body.forEach(c => visit(c, s, node));
                return;
            }
            case 'ForStatement':
            case 'ForInStatement':
            case 'ForOfStatement': {
                const s = new Scope(scope, false);
                const head = node.type === 'ForStatement' ? node.init : node.left;
                if (head?.type === 'VariableDeclaration' && head.kind !== 'var') {
                    head.declarations.forEach(d => patternNames(d.id, s.names));
                }
                children(node).forEach(c => visit(c, s, node));
                return;
            }
            case 'SwitchStatement': {
                visit(node.discriminant, scope, node);
                const s = new Scope(scope, false);
                node.cases.forEach(c => lexicalNames(c.consequent, s.names));
                node.cases.forEach(c => visit(c, s, node));
                return;
            }
            case 'CatchClause': {
                const s = new Scope(scope, false);
                if (node.param) {
                    patternNames(node.param, s.names);
                    visitBinding(node.param, s, node);
                }
                visit(node.body, s, node);
                return;
            }
            case 'VariableDeclaration':
                for (const d of node.declarations) {
                    d._p = node;
                    visitBinding(d.id, scope, d);
                    visit(d.init, scope, d);
                }
                return;
            case 'ClassDeclaration':
            case 'ClassExpression':
                if (node.id) idents.add(node.id.name);
                visit(node.superClass, scope, node);
                visit(node.body, scope, node);
                return;
            case 'MethodDefinition':
            case 'PropertyDefinition':
                if (node.computed) visit(node.key, scope, node);
                visit(node.value, scope, node);
                return;
            case 'MemberExpression':
                visit(node.object, scope, node);
                if (node.computed) visit(node.property, scope, node);
                else if (node.property.type === 'Identifier') idents.add(node.property.name);
                return;
            case 'Property': {
                if (node.computed) visit(node.key, scope, node);
                else if (node.key.type === 'Identifier') idents.add(node.key.name);
                const before = refs.length;
                visit(node.value, scope, node);
                if (node.shorthand) {
                    // { X } や ({ X = 1 } = obj) の X。書き換えるときは「X: 式」の形にする
                    const target = node.value.type === 'AssignmentPattern' ? node.value.left : node.value;
                    for (let i = before; i < refs.length; i++) {
                        if (refs[i].node === target) refs[i].shorthand = true;
                    }
                }
                return;
            }
            case 'LabeledStatement':
                visit(node.body, scope, node);
                return;
            case 'BreakStatement':
            case 'ContinueStatement':
            case 'MetaProperty':
                return;
            case 'CallExpression': {
                // その場で呼ばれる関数は、「あとで呼ばれる関数」に数えない
                if (isFunction(node.callee)) node.callee._immediate = true;
                const c = node.callee;
                if (c.type === 'MemberExpression' && !c.computed && SYNC_METHODS.has(c.property.name)) {
                    node.arguments.forEach(a => { if (isFunction(a)) a._immediate = true; });
                }
                children(node).forEach(ch => visit(ch, scope, node));
                return;
            }
            default:
                children(node).forEach(c => visit(c, scope, node));
        }
    };

    const programScope = new Scope(null, false);
    collectVars(ast, programScope.names);
    lexicalNames(ast.body, programScope.names);
    ast._scope = programScope;
    ast.body.forEach(c => visit(c, programScope, ast));
    return { refs, idents, programScope };
};

/** 参照が指す宣言のスコープと、その間に挟まる「あとで呼ばれる関数」の数。宣言が無ければ scope は null */
export const resolve = ref => {
    let depth = 0;
    for (let s = ref.scope; s !== null; s = s.parent) {
        if (s.names.has(ref.name)) return { scope: s, depth };
        if (s.boundary) depth++;
    }
    return { scope: null, depth };
};

/**
 * 参照から続く「.a.b」の道のりと、その使われ方
 * @returns {{ path: string[], top: object, dynamic: boolean, write: boolean }}
 *   dynamic … 途中に obj[x] の形があって、先を追えない / write … その道のりへ書き込んでいる
 */
export const memberChain = ref => {
    const path = [];
    let cur = ref.node;
    let dynamic = false;
    for (;;) {
        const p = cur._p;
        if (p?.type !== 'MemberExpression' || p.object !== cur) break;
        if (!p.computed && p.property.type === 'Identifier') {
            path.push(p.property.name);
        } else if (p.computed && p.property.type === 'Literal' && ['string', 'number'].includes(typeof p.property.value)) {
            path.push(String(p.property.value));
        } else {
            dynamic = true;
            break;
        }
        cur = p;
    }
    const p = cur._p;
    const write = (p?.type === 'AssignmentExpression' && p.left === cur)
        || (p?.type === 'UpdateExpression' && p.argument === cur)
        || (p?.type === 'UnaryExpression' && p.operator === 'delete' && p.argument === cur);
    return { path, top: cur, dynamic, write };
};
