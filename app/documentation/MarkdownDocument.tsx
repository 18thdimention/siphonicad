"use client"

import React, { useEffect, useState } from "react"

function renderMarkdown(markdown: string): React.ReactElement {
  const lines = markdown.split(/\r?\n/)

  const elements: React.ReactElement[] = []
  let listItems: string[] = []

  const flushList = () => {
    if (listItems.length === 0) return
    const items = listItems.map((item, index) => <li key={index}>{item}</li>)
    elements.push(<ul className="list-disc pl-6 space-y-1" key={`list-${elements.length}`}>{items}</ul>)
    listItems = []
  }

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd()

    if (!line.trim()) {
      flushList()
      return
    }

    if (line.startsWith("# ")) {
      flushList()
      elements.push(
        <h1 className="text-3xl font-bold mb-4" key={`h1-${index}`}>
          {line.slice(2)}
        </h1>,
      )
      return
    }

    if (line.startsWith("## ")) {
      flushList()
      elements.push(
        <h2 className="text-2xl font-semibold mt-6 mb-3" key={`h2-${index}`}>
          {line.slice(3)}
        </h2>,
      )
      return
    }

    if (line.startsWith("### ")) {
      flushList()
      elements.push(
        <h3 className="text-xl font-semibold mt-4 mb-2" key={`h3-${index}`}>
          {line.slice(4)}
        </h3>,
      )
      return
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      listItems.push(line.slice(2))
      return
    }

    flushList()
    elements.push(
      <p className="mb-3 leading-relaxed" key={`p-${index}`}>
        {line}
      </p>,
    )
  })

  flushList()

  return <div>{elements}</div>
}

export function MarkdownDocument() {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch("/documentation.md")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load documentation: ${res.status}`)
        const text = await res.text()
        if (!cancelled) {
          setContent(text)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load documentation.")
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return <div className="text-red-500">{error}</div>
  }

  if (content === null) {
    return <div className="text-sm text-muted-foreground">Loading documentation…</div>
  }

  return (
    <article className="prose max-w-none">
      {renderMarkdown(content)}
    </article>
  )
}
