/**
 * A tiny XML reader for the registrar APIs that answer in XML (Namecheap, Route 53).
 * Handles elements, attributes, text, CDATA, entities, comments and namespaces
 * (prefixes are dropped). It is not a validating parser.
 */

export interface XmlNode {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    text: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
        if (e[0] === "#") {
            const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            try {
                return String.fromCodePoint(code);
            } catch {
                return whole;
            }
        }
        return NAMED[e.toLowerCase()] ?? whole;
    });
}

const strip = (name: string) => name.replace(/^.*:/, "");

/** Returns the root element, or an empty node (name "") when the text isn't XML. */
export function parseXml(source: string): XmlNode {
    const empty: XmlNode = { name: "", attrs: {}, children: [], text: "" };
    const holder: XmlNode = { name: "#holder", attrs: {}, children: [], text: "" };
    const stack: XmlNode[] = [holder];

    // groups: 1 CDATA, 2 closing tag, 3 opening tag name, 4 attributes, 5 self-closing slash, 6 text
    const re =
        /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        const top = stack[stack.length - 1];

        if (m[1] !== undefined) {
            top.text += m[1];
        } else if (m[2] !== undefined) {
            if (stack.length > 1) stack.pop();
        } else if (m[3] !== undefined) {
            const node: XmlNode = { name: strip(m[3]), attrs: {}, children: [], text: "" };
            const attr = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
            let a: RegExpExecArray | null;
            while ((a = attr.exec(m[4] ?? ""))) node.attrs[strip(a[1])] = decode(a[2] ?? a[3] ?? "");
            top.children.push(node);
            if (!m[5]) stack.push(node);
        } else if (m[6] !== undefined) {
            top.text += decode(m[6]);
        }
    }
    return holder.children[0] ?? empty;
}

/** Direct children, optionally only those called `name`. */
export function kids(node: XmlNode | undefined, name?: string): XmlNode[] {
    return (node?.children ?? []).filter((c) => !name || c.name === name);
}

export function kid(node: XmlNode | undefined, name: string): XmlNode | undefined {
    return kids(node, name)[0];
}

/** Every element called `name` anywhere below `node`, in document order. */
export function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
    const out: XmlNode[] = [];
    const walk = (n: XmlNode) => {
        for (const c of n.children) {
            if (c.name === name) out.push(c);
            walk(c);
        }
    };
    if (node) walk(node);
    return out;
}

export function textOf(node: XmlNode | undefined): string {
    return (node?.text ?? "").trim();
}

/** Text of the first element called `name` below `node`. */
export function valueOf(node: XmlNode | undefined, name: string): string {
    return textOf(descendants(node, name)[0]);
}