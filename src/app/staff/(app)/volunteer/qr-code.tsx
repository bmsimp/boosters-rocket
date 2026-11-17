import "server-only";
import QRCode from "qrcode";

/**
 * A QR code for `text`, drawn on the server as SVG: one path of squares, from the package's matrix (QRCode.create).
 * Nothing is sent to the browser but the drawing: no script, no image file, no HTML string. The text is the portal's
 * own address and a check-in code, never anything a family typed. Dark modules are black on white whatever the theme,
 * since a forced-colors theme changes `currentColor` but not a fill (a white code on white in a dark contrast theme),
 * with the four-module quiet zone scanners need.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const quiet = 4, size = modules.size + quiet * 2;
  const squares: string[] = [];
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) squares.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
  }
  return (
    <svg className="checkin-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect width={size} height={size} fill="white" />
      <path d={squares.join("")} fill="black" />
    </svg>
  );
}
