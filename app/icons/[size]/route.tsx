import { ImageResponse } from "next/og";

// App icon: a steering wheel in the lane-marker yellow on asphalt.
// Drawn full-bleed so it also works as a maskable icon.
const SIZES = [180, 192, 512];

export const dynamic = "force-static";
export function generateStaticParams() {
  return SIZES.map((s) => ({ size: String(s) }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size: raw } = await params;
  const size = SIZES.includes(Number(raw)) ? Number(raw) : 512;
  const u = size / 100;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#2E3136",
        }}
      >
        <div
          style={{
            position: "relative",
            width: 58 * u,
            height: 58 * u,
            borderRadius: "50%",
            border: `${7 * u}px solid #F5C518`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: 21 * u, height: 7 * u, background: "#F5C518" }} />
          <div style={{ position: "absolute", left: 18.5 * u, top: 24 * u, width: 7 * u, bottom: 0, background: "#F5C518" }} />
          <div style={{ width: 16 * u, height: 16 * u, borderRadius: "50%", background: "#F5C518" }} />
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
