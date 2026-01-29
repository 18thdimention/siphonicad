"use client";
import React from "react";
import { TextHoverEffect } from "@/components/ui/text-hover-effect";
import Link from 'next/link'

export default function Home() {
  return (
    <main>
      <div className="mt-30 flex items-center justify-center">
        <TextHoverEffect text="GBK" />
      </div>
      <div className="text-center">
        <Link href="/login">
          <button className="px-12 py-2 border rounded-full font-mono text-neutral-200 hover:text-neutral-900">
            GET STARTED
          </button>
        </Link>
      </div>
    </main>
  );
}
