"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import EmptyDashboard from "@/components/empty-dashboard"; // ⬅️ import your empty state
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import Header from "@/components/header";
import { AppSidebar } from "@/components/app-sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MoreHorizontal } from "lucide-react";

export default function OrgPage() {
  const { orgId } = useParams();
  const router = useRouter();
  const [folders, setFolders] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Global view of all project files (ignores organization for now)
  const [projectFiles, setProjectFiles] = useState<any[] | null>(null);
  const [projectFilesError, setProjectFilesError] = useState<string | null>(null);

  // Create/import project from the global list
  const [creatingProject, setCreatingProject] = useState(false);
  const [showCreateOptions, setShowCreateOptions] = useState(false);

  // Per-file options (three-dot popover)
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);

  async function loadFolders() {
    const { data } = await supabase
      .from("folders")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    setFolders(data || []);
  }

  useEffect(() => {
    loadFolders();
  }, [orgId]);

  // Load all project_files without filtering by organization
  useEffect(() => {
    async function loadProjectFiles() {
      const { data, error } = await supabase
        .from("project_files")
        .select("id, name, project_id, created_at")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error loading project files:", error);
        setProjectFilesError(error.message);
        setProjectFiles([]);
        return;
      }

      setProjectFiles(data || []);
    }

    loadProjectFiles();
  }, []);

  // Keep track of the active orgId so the sidebar can build org-scoped links
  useEffect(() => {
    if (orgId && typeof window !== "undefined") {
      window.localStorage.setItem("currentOrgId", String(orgId));
    }
  }, [orgId]);

  async function createFolder() {
    const user = (await supabase.auth.getUser()).data.user;
    await supabase.from("folders").insert([
      { name: newFolder, organization_id: orgId, created_by: user?.id },
    ]);
    setShowModal(false);
    setNewFolder("");
    loadFolders();
  }

  async function importProjectFromFile(file: File) {
    if (importing) return;
    setImporting(true);
    try {
      const resolvedOrgId =
        (typeof orgId === "string" ? orgId : Array.isArray(orgId) ? orgId[0] : undefined) ||
        (typeof window !== "undefined"
          ? window.localStorage.getItem("currentOrgId") ?? undefined
          : undefined);

      if (!resolvedOrgId) {
        alert("Missing organization. Please open an organization first.");
        return;
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        router.push("/login");
        return;
      }

      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        alert("Invalid JSON file");
        return;
      }

      const projectName =
        (typeof parsed?.name === "string" && parsed.name.trim().length > 0
          ? parsed.name.trim()
          : file.name.replace(/\.json$/i, "") || "Imported Project");

      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: projectName,
          organization_id: resolvedOrgId,
          user_id: user.id,
        }),
      });

      if (!projectRes.ok) {
        const body = await projectRes.json().catch(() => ({}));
        console.error("Error creating imported project via API", body);
        alert(body.error ?? "Failed to create project from file");
        return;
      }

      const projectRow = (await projectRes.json()) as { id: string };
      const projectId = projectRow.id;

      const fileDisplayName =
        (typeof parsed?.fileName === "string" && parsed.fileName.trim().length > 0
          ? parsed.fileName.trim()
          : projectName);

      const { data: fileRow, error: fileError } = await supabase
        .from("project_files")
        .insert({
          project_id: projectId,
          name: fileDisplayName,
          data: parsed,
        })
        .select("id")
        .single();

      if (fileError) {
        console.error("Error creating imported project file", fileError);
        alert("Failed to create project file from JSON");
        return;
      }

      const newFileId = (fileRow as { id: string }).id;
      router.push(`/canvas?projectId=${projectId}&fileId=${newFileId}`);
    } finally {
      setImporting(false);
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleCreateProject() {
    if (creatingProject) return;
    setCreatingProject(true);
    try {
      const resolvedOrgId =
        (typeof orgId === "string" ? orgId : Array.isArray(orgId) ? orgId[0] : undefined) ||
        (typeof window !== "undefined"
          ? window.localStorage.getItem("currentOrgId") ?? undefined
          : undefined);

      if (!resolvedOrgId) {
        alert("Missing organization. Please open an organization first.");
        return;
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        router.push("/login");
        return;
      }

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New Project",
          organization_id: resolvedOrgId,
          user_id: user.id,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("Error creating project via API", body);
        alert(body.error ?? "Failed to create project");
        return;
      }

      const project = (await res.json()) as { id: string };
      const projectId = project.id;
      router.push(`/canvas?projectId=${projectId}`);
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await importProjectFromFile(file);
    e.target.value = "";
  }

  async function handleRenameFile(fileId: string, currentName: string | null) {
    if (renamingFileId) return;
    const nextName = window.prompt("Rename design", currentName || "Untitled design");
    if (!nextName || !nextName.trim()) return;

    setRenamingFileId(fileId);
    try {
      const { error } = await supabase
        .from("project_files")
        .update({ name: nextName.trim() })
        .eq("id", fileId);

      if (error) {
        console.error("Error renaming project file", error);
        alert("Failed to rename project file");
        return;
      }

      setProjectFiles((prev) =>
        prev ? prev.map((f) => (f.id === fileId ? { ...f, name: nextName.trim() } : f)) : prev,
      );
    } finally {
      setRenamingFileId(null);
    }
  }

  async function handleDeleteFile(fileId: string) {
    if (deletingFileId) return;
    const confirmed = window.confirm("Delete this design file? This cannot be undone.");
    if (!confirmed) return;

    setDeletingFileId(fileId);
    try {
      const { error } = await supabase.from("project_files").delete().eq("id", fileId);
      if (error) {
        console.error("Error deleting project file", error);
        alert("Failed to delete project file");
        return;
      }

      setProjectFiles((prev) => (prev ? prev.filter((f) => f.id !== fileId) : prev));
    } finally {
      setDeletingFileId(null);
    }
  }

  // If there are any project_files at all, show a global list and skip the
  // "create new project" empty state. This ignores organization for now.
  if (projectFiles && projectFiles.length > 0) {
    return (
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <Header />
          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold">All project files</h1>
            </div>

            {projectFilesError && (
              <p className="text-sm text-red-500">
                Error loading project files: {projectFilesError}
              </p>
            )}

            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {/* Create New + card */}
              <Card
                className="cursor-pointer border-dashed border-2 shadow-none py-0 transition hover:border-primary/60"
                onClick={() => setShowCreateOptions(true)}
              >
                <CardHeader className="px-4 py-3">
                  <CardTitle className="text-sm font-medium">+ Create New</CardTitle>
                  <CardDescription className="text-[11px]">
                    Start a new project or import from JSON.
                  </CardDescription>
                </CardHeader>
              </Card>

              {/* Existing project files */}
              {projectFiles.map((file) => (
                <Card
                  key={file.id}
                  onClick={() =>
                    router.push(
                      `/canvas?projectId=${file.project_id}&fileId=${file.id}`,
                    )
                  }
                  className="cursor-pointer border shadow-none py-0 transition hover:border-primary/60"
                >
                  <CardHeader className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-sm font-medium">
                          {file.name || "Untitled design"}
                        </CardTitle>
                        {file.created_at && (
                          <CardDescription className="text-[11px]">
                            Saved {new Date(file.created_at).toLocaleString()}
                          </CardDescription>
                        )}
                      </div>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent hover:bg-muted focus:outline-none"
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">More options</span>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="end"
                          className="w-44 rounded-md border bg-background p-1 text-xs shadow-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex flex-col gap-0.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 justify-start px-2 text-[11px]"
                              onClick={() =>
                                void handleRenameFile(file.id, file.name ?? null)
                              }
                              disabled={renamingFileId === file.id}
                            >
                              {renamingFileId === file.id ? "Renaming..." : "Rename"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 justify-start px-2 text-[11px]"
                              onClick={() =>
                                router.push(
                                  `/canvas?projectId=${file.project_id}&fileId=${file.id}&export=equations`,
                                )
                              }
                            >
                              Export Excel
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 justify-start px-2 text-[11px]"
                              onClick={() =>
                                router.push(
                                  `/canvas?projectId=${file.project_id}&fileId=${file.id}&export=quantities`,
                                )
                              }
                            >
                              Export quantities
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 justify-start px-2 text-[11px] text-red-600 hover:text-red-600"
                              onClick={() => void handleDeleteFile(file.id)}
                              disabled={deletingFileId === file.id}
                            >
                              {deletingFileId === file.id ? "Deleting..." : "Delete"}
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {/* Hidden file input for import */}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleFileInputChange}
            />

            {/* Dialog with create/import options */}
            <Dialog open={showCreateOptions} onOpenChange={setShowCreateOptions}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create or import project</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                  <Button
                    onClick={async () => {
                      setShowCreateOptions(false);
                      await handleCreateProject();
                    }}
                    disabled={creatingProject}
                  >
                    {creatingProject ? "Creating..." : "Create new project"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowCreateOptions(false);
                      handleImportClick();
                    }}
                    disabled={importing}
                  >
                    {importing ? "Importing..." : "Import project from JSON"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </SidebarInset>
      </SidebarProvider>
    );
  }

  // ✅ If there are no folders, show the EmptyDashboard
  if (!folders?.length) {
    return (
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <Header />
          <div className="flex flex-col items-center justify-center h-full p-8">
            <EmptyDashboard orgId={orgId} />
          </div>
        </SidebarInset>
      </SidebarProvider >
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Folders</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowModal(true)}>+ New Folder</Button>
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
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {folders.map((f) => (
          <Card
            key={f.id}
            onClick={() => router.push(`/orgs/${orgId}/folders/${f.id}`)}
            className="cursor-pointer hover:shadow-md transition"
          >
            <CardHeader>
              <CardTitle>{f.name}</CardTitle>
              <CardDescription>Created {new Date(f.created_at).toLocaleDateString()}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Folder</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Folder name"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
          />
          <Button onClick={createFolder} className="mt-3">
            Create
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}