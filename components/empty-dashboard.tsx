"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowUpRightIcon, FolderGit2Icon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { supabase } from "@/lib/supabaseClient"

interface EmptyDashboardProps {
  orgId?: string | string[];
}

export default function EmptyDashboard({ orgId }: EmptyDashboardProps) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function handleCreateProject() {
    if (creating) return
    setCreating(true)
    try {
      const resolvedOrgId =
        (typeof orgId === "string" ? orgId : orgId?.[0]) ||
        (typeof window !== "undefined"
          ? window.localStorage.getItem("currentOrgId") ?? undefined
          : undefined)

      if (!resolvedOrgId) {
        alert("Missing organization. Please open an organization first.")
        return
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser()

      if (userError || !user) {
        router.push("/login")
        return
      }

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New Project",
          organization_id: resolvedOrgId,
          user_id: user.id,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        console.error("Error creating project via API", body)
        alert(body.error ?? "Failed to create project")
        return
      }

      const project = (await res.json()) as { id: string }
      const projectId = project.id
      // Go straight into the canvas bound to this project so Save works
      router.push(`/canvas?projectId=${projectId}`)
    } finally {
      setCreating(false)
    }
  }

  async function handleImportFile(file: File) {
    if (importing) return
    setImporting(true)
    try {
      const resolvedOrgId =
        (typeof orgId === "string" ? orgId : orgId?.[0]) ||
        (typeof window !== "undefined"
          ? window.localStorage.getItem("currentOrgId") ?? undefined
          : undefined)

      if (!resolvedOrgId) {
        alert("Missing organization. Please open an organization first.")
        return
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser()

      if (userError || !user) {
        router.push("/login")
        return
      }

      const text = await file.text()
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        alert("Invalid JSON file")
        return
      }

      const projectName =
        (typeof parsed?.name === "string" && parsed.name.trim().length > 0
          ? parsed.name.trim()
          : file.name.replace(/\.json$/i, "") || "Imported Project")

      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: projectName,
          organization_id: resolvedOrgId,
          user_id: user.id,
        }),
      })

      if (!projectRes.ok) {
        const body = await projectRes.json().catch(() => ({}))
        console.error("Error creating imported project via API", body)
        alert(body.error ?? "Failed to create project from file")
        return
      }

      const projectRow = (await projectRes.json()) as { id: string }
      const projectId = projectRow.id

      const fileDisplayName =
        (typeof parsed?.fileName === "string" && parsed.fileName.trim().length > 0
          ? parsed.fileName.trim()
          : projectName)

      const { data: fileRow, error: fileError } = await supabase
        .from("project_files")
        .insert({
          project_id: projectId,
          name: fileDisplayName,
          data: parsed,
        })
        .select("id")
        .single()

      if (fileError) {
        console.error("Error creating imported project file", fileError)
        alert("Failed to create project file from JSON")
        return
      }

      const newFileId = (fileRow as { id: string }).id
      router.push(`/canvas?projectId=${projectId}&fileId=${newFileId}`)
    } finally {
      setImporting(false)
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  async function handleFileInputChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0]
    if (!file) return
    await handleImportFile(file)
    // Reset input so selecting the same file again still triggers onChange
    event.target.value = ""
  }

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2Icon/>
        </EmptyMedia>
        <EmptyTitle>No Projects Yet</EmptyTitle>
        <EmptyDescription>
          You haven&apos;t created any projects yet. Get started by creating
          your first project.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button onClick={handleCreateProject} disabled={creating}>
            {creating ? "Creating..." : "Create Project"}
          </Button>
          <Button
            variant="outline"
            onClick={handleImportClick}
            disabled={importing}
          >
            {importing ? "Importing..." : "Import Project"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleFileInputChange}
          />
        </div>
      </EmptyContent>
      <Button
        variant="link"
        asChild
        className="text-muted-foreground"
        size="sm"
      >
        <Link href="/documentation">
          Learn More <ArrowUpRightIcon />
        </Link>
      </Button>
    </Empty>
  )
}