import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tilt Wheel",
    short_name: "Tilt Wheel",
    description: "Turn your phone into a gyro steering wheel for PC racing games.",
    id: "/play",
    start_url: "/play",
    scope: "/",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#2E3136",
    theme_color: "#2E3136",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
