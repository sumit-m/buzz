import * as React from "react";

import type { ProjectRepoFile } from "@/features/projects/hooks";

import {
  existingFolder,
  freshFile,
  isFolderPath,
  parentPath,
} from "./repositoryNavigation";

export type RepositoryFilesContext = {
  kind: "file" | "folder";
  onBack?: () => void;
  path: string;
};

export function useRepositoryFilesNavigation({
  files,
  initialPath,
  onContextChange,
  pageSize,
}: {
  files: ProjectRepoFile[];
  initialPath?: string;
  onContextChange?: (context: RepositoryFilesContext) => void;
  pageSize: number;
}) {
  const [currentPath, setCurrentPath] = React.useState("");
  const [selectedFile, setSelectedFile] =
    React.useState<ProjectRepoFile | null>(null);
  const [visibleEntryCount, setVisibleEntryCount] = React.useState(pageSize);
  // LOCAL DIVERGENCE: a file path not in the list yet (an image just moved
  // from the sidebar) opens once a refresh brings it in.
  const [pendingFilePath, setPendingFilePath] = React.useState<string | null>(
    null,
  );
  const openPath = React.useCallback(
    (path: string) => {
      const file = files.find((entry) => entry.path === path);
      if (!file && !isFolderPath(files, path)) {
        setPendingFilePath(path);
        return;
      }
      setPendingFilePath(null);
      setCurrentPath(file ? parentPath(path) : path);
      setSelectedFile(file ?? null);
      setVisibleEntryCount(pageSize);
    },
    [files, pageSize],
  );
  const contextBack = React.useMemo(() => {
    if (selectedFile) return () => setSelectedFile(null);
    if (!currentPath) return undefined;
    return () => {
      const segments = currentPath.split("/");
      openPath(segments.slice(0, -1).join("/"));
    };
  }, [currentPath, openPath, selectedFile]);

  React.useEffect(() => {
    onContextChange?.({
      kind: selectedFile ? "file" : "folder",
      onBack: contextBack,
      path: selectedFile?.path ?? currentPath,
    });
  }, [contextBack, currentPath, onContextChange, selectedFile]);

  const filesKey = React.useMemo(
    () => files.map((file) => file.path).join("\0"),
    [files],
  );
  const initialFile = React.useMemo(
    () =>
      initialPath
        ? (files.find((file) => file.path === initialPath) ?? null)
        : null,
    [files, initialPath],
  );
  // LOCAL DIVERGENCE: the initial path applies once per initialPath, not on
  // every file-list change; see repositoryNavigation.ts.
  const appliedInitialPath = React.useRef<{ path?: string } | null>(null);
  React.useEffect(() => {
    if (!filesKey) return;
    if (appliedInitialPath.current?.path === initialPath) return;
    appliedInitialPath.current = { path: initialPath };
    const initialDirectory = initialFile
      ? initialFile.path.split("/").slice(0, -1).join("/")
      : (initialPath ?? "");
    setCurrentPath(initialDirectory);
    setSelectedFile(initialFile);
    setVisibleEntryCount(pageSize);
    if (!initialFile && initialPath && !isFolderPath(files, initialPath)) {
      setPendingFilePath(initialPath);
    }
  }, [files, filesKey, initialFile, initialPath, pageSize]);

  React.useEffect(() => {
    if (!files.length) return;
    const pending = pendingFilePath
      ? files.find((file) => file.path === pendingFilePath)
      : undefined;
    if (pending) {
      setPendingFilePath(null);
      setCurrentPath(parentPath(pending.path));
      setSelectedFile(pending);
      return;
    }
    setSelectedFile((current) => freshFile(files, current));
    setCurrentPath((path) => existingFolder(files, path));
  }, [files, pendingFilePath]);

  return {
    currentPath,
    openPath,
    selectedFile,
    setSelectedFile,
    setVisibleEntryCount,
    visibleEntryCount,
  };
}
