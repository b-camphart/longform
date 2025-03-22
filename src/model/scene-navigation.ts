import { normalizePath, type Vault } from "obsidian";
import type { Draft, MultipleSceneDraft } from "./types";

/**
 * @returns The path to the draft project folder, or null if it cannot be found.
 */
export function projectFolderPath(draft: Draft, vault: Vault): string | null {
  const file = vault.getAbstractFileByPath(draft.vaultPath);
  if (file === null) {
    console.error(
      `[Longform] Cannot find index file for ${draft.title} at ${draft.vaultPath}`
    );
    return null;
  }
  const parent = file.parent;
  if (parent === null) {
    console.error(
      `[Longform] Cannot find parent folder for ${draft.title} at ${draft.vaultPath}`
    );
    return null;
  }
  return parent.path;
}

/**
 * @returns the path to the scene folder, or null if the draft cannot be found.
 */
export function sceneFolderPath(
  draft: MultipleSceneDraft,
  vault: Vault
): string | null {
  const root = projectFolderPath(draft, vault);
  if (root === null) return null;
  return normalizePath(`${root}/${draft.sceneFolder}`);
}

export function scenePathForFolder(
  sceneName: string,
  folderPath: string
): string {
  return normalizePath(`${folderPath}/${sceneName}.md`);
}
/**
 * @returns the path to the scene file, or null if the draft index file cannot be found.
 */
export function scenePath(
  sceneName: string,
  draft: MultipleSceneDraft,
  vault: Vault
): string | null {
  const sceneFolder = sceneFolderPath(draft, vault);
  if (sceneFolder === null) {
    console.error(
      `[Longform] Cannot find scene folder for ${draft.title} at ${draft.vaultPath}`
    );
    return null;
  }
  return scenePathForFolder(sceneName, sceneFolder);
}

export function findScene(
  path: string,
  drafts: Draft[]
): { draft: Draft; index: number; currentIndent: number } | null {
  for (const draft of drafts) {
    if (draft.format === "scenes") {
      const parentPath = draft.vaultPath.split("/").slice(0, -1).join("/");
      if (parentPath !== "" && !parentPath) {
        continue;
      }
      const index = draft.scenes.findIndex(
        (s) =>
          normalizePath(`${parentPath}/${draft.sceneFolder}/${s.title}.md`) ===
          path
      );
      if (index >= 0) {
        return { draft, index, currentIndent: draft.scenes[index].indent };
      }
    }
  }
  return null;
}

export function draftForPath(path: string, drafts: Draft[]): Draft | null {
  for (const draft of drafts) {
    if (draft.vaultPath === path) {
      return draft;
    } else {
      const found = findScene(path, drafts);
      if (found) {
        return found.draft;
      }
    }
  }
  return null;
}

export type SceneNavigationLocation = {
  position: "next" | "previous";
  maintainIndent: boolean;
};

export function scenePathForLocation(
  location: SceneNavigationLocation,
  path: string,
  drafts: Draft[],
  vault: Vault
): string | null {
  for (const draft of drafts) {
    if (draft.format === "scenes") {
      const root = projectFolderPath(draft, vault);
      if (root === null) {
        continue;
      }
      const index = draft.scenes.findIndex(
        (s) =>
          normalizePath(`${root}/${draft.sceneFolder}/${s.title}.md`) === path
      );
      if (index >= 0) {
        if (location.position === "next" && index < draft.scenes.length - 1) {
          if (!location.maintainIndent) {
            const nextScene = draft.scenes[index + 1];
            return normalizePath(
              `${root}/${draft.sceneFolder}/${nextScene.title}.md`
            );
          } else {
            const indent = draft.scenes[index].indent;
            const nextSceneAtIndent = draft.scenes
              .slice(index + 1)
              .find((s) => s.indent === indent);
            if (nextSceneAtIndent) {
              return normalizePath(
                `${root}/${draft.sceneFolder}/${nextSceneAtIndent.title}.md`
              );
            }
          }
        } else if (location.position === "previous" && index > 0) {
          if (!location.maintainIndent) {
            const previousScene = draft.scenes[index - 1];
            return normalizePath(
              `${root}/${draft.sceneFolder}/${previousScene.title}.md`
            );
          } else {
            const indent = draft.scenes[index].indent;
            const previousSceneAtIndent = draft.scenes
              .slice(0, index)
              .find((s) => s.indent === indent);
            if (previousSceneAtIndent) {
              return normalizePath(
                `${root}/${draft.sceneFolder}/${previousSceneAtIndent.title}.md`
              );
            }
          }
        }
      }
    }
  }
  return null;
}
