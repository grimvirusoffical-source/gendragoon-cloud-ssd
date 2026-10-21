import qrcode from "qrcode-generator";

/**
 * QR code for an otpauth:// URI as an SVG path (one unit per module, with a
 * 4-module quiet zone). Renders the same with <svg> on desktop and the
 * extension and with react-native-svg on mobile.
 */
export function qrSvgPath(text: string): { size: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return { size: count + quiet * 2, path };
}

/** Same matrix, for tests and for a text fallback. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => qr.isDark(row, col)));
}
