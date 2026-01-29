import { Suspense } from "react";
import IsometricCanvas from "@/components/IsometricCanvas";

export default function Canvas() {
  return (
    <main className="w-screen h-screen overflow-hidden">
      <Suspense fallback={null}>
        <IsometricCanvas />
      </Suspense>
    </main>
  );
}
