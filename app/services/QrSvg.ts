/**
 * A QR code as an SVG data URL, for <img src>. The otpauth:// URI for an
 * authenticator app is encoded here, on the server, so the secret never
 * goes to a third-party QR service. The encoder is the one @tylix/pdf uses
 * for QR codes in documents (no dependencies).
 *
 * The default Tylix CSP allows data: images (img-src 'self' data: ...).
 */

import { qrMatrix } from "@tylix/pdf";

/** Dark modules as one SVG path: a horizontal run per row segment. */
function pathFor(matrix: boolean[][], margin: number): string {
    const parts: string[] = [];
    matrix.forEach((row, y) => {
        let x = 0;
        while (x < row.length) {
            if (!row[x]) {
                x++;
                continue;
            }
            const start = x;
            while (x < row.length && row[x]) x++;
            parts.push(`M${start + margin} ${y + margin}h${x - start}v1h-${x - start}z`);
        }
    });
    return parts.join("");
}

export function qrSvg(text: string, { margin = 4, level = "M" as "L" | "M" | "Q" | "H" } = {}): string {
    const matrix = qrMatrix(text, { level });
    const size = matrix.length + margin * 2;
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
        `<rect width="${size}" height="${size}" fill="#fff"/>` +
        `<path fill="#000" d="${pathFor(matrix, margin)}"/></svg>`
    );
}

export function qrDataUrl(text: string, options?: { margin?: number; level?: "L" | "M" | "Q" | "H" }): string {
    return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options)).toString("base64")}`;
}
