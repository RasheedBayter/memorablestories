import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Movimiento ② del encargo: la fila de la sala de control **se convierte**
    // en la cabecera del episodio. Con `<ViewTransition>` de React el morph
    // ocurre de verdad entre rutas, sin librería de animación por encima.
    viewTransition: true,
  },
  // El SDK de ElevenLabs habla con la red y con el sistema de ficheros: no se
  // empaqueta para el bundle del servidor.
  serverExternalPackages: ["@elevenlabs/elevenlabs-js"],
};

export default nextConfig;
