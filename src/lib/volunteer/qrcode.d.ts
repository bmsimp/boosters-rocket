// The part of the qrcode package (an exact version in package.json) the check-in sheet uses: the matrix of a QR code,
// which src/app/staff/(app)/volunteer/qr-code.tsx draws as SVG on the server. The package ships no types of its own.
declare module "qrcode" {
  export type QRCodeErrorCorrectionLevel = "L" | "M" | "Q" | "H";
  export type QRCodeMatrix = { size: number; data: Uint8Array; get(row: number, col: number): number | boolean };
  export type QRCodeSymbol = { modules: QRCodeMatrix; version: number };
  export function create(text: string, options?: { errorCorrectionLevel?: QRCodeErrorCorrectionLevel }): QRCodeSymbol;
  const QRCode: { create: typeof create };
  export default QRCode;
}
