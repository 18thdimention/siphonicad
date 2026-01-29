"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

export default function ProjectPage() {
  const { orgId, projectId } = useParams();
  const router = useRouter();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<any[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);

  useEffect(() => {
    async function loadProjectAndFiles() {
      setLoading(true);
      setFilesLoading(true);

      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .eq("organization_id", orgId)
        .single();

      if (error) {
        console.error("Error loading project:", error);
        setLoading(false);
        setFilesLoading(false);
        return;
      }

      setProject(data);
      setLoading(false);

      // Load all saved canvas files for this project.
      const { data: fileData, error: fileError } = await supabase
        .from("project_files")
        .select("id, name, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });

      if (fileError) {
        console.error("Error loading project files:", fileError);
        setFiles([]);
      } else {
        setFiles(fileData || []);
      }

      setFilesLoading(false);
    }

    loadProjectAndFiles();
  }, [projectId, orgId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Loading project...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <p className="text-muted-foreground mb-4">Project not found</p>
        <Button onClick={() => router.push(`/orgs/${orgId}`)}>
          Back to Projects
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex justify-between items-center">
        <div>
          <Button 
            variant="ghost" 
            onClick={() => router.push(`/orgs/${orgId}`)}
            className="mb-2"
          >
            ← Back to Projects
          </Button>
          <h1 className="text-3xl font-bold">{project.name}</h1>
          <p className="text-muted-foreground mt-1">
            Created {new Date(project.created_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      <Card className="py-3">
        <CardHeader className="px-4 py-2.5">
          <CardTitle className="text-base">Project Details</CardTitle>
          <CardDescription className="text-xs">Project information and settings</CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">Project ID</p>
              <p className="text-xs">{project.id}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">Organization ID</p>
              <p className="text-xs">{project.organization_id}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">Created At</p>
              <p className="text-xs">{new Date(project.created_at).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Design files</h2>
          <Button
            variant="outline"
            onClick={() => router.push(`/canvas?projectId=${projectId}`)}
          >
            New canvas
          </Button>
        </div>

        {filesLoading ? (
          <p className="text-sm text-muted-foreground">Loading files...</p>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No files saved yet. Use the canvas Save button to create one.
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {files.map((file) => (
              <Card
                key={file.id}
                className="cursor-pointer border shadow-none py-0 transition hover:border-primary/60"
                onClick={() =>
                  router.push(`/canvas?projectId=${projectId}&fileId=${file.id}`)
                }
              >
                <CardHeader className="px-4 py-3">
                  <CardTitle className="text-sm font-medium">
                    {file.name || "Untitled design"}
                  </CardTitle>
                  <CardDescription className="text-[11px]">
                    Saved {new Date(file.created_at).toLocaleString()}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

