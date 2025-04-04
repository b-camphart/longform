<script lang="ts">
  /* Note: VSCode doesn't love the use of generics + let:item
     in the html section here. I'm not sure what to do about it;
     it's valid svelte and doesn't typeerror on compile.
  */
  import type Sortable from "sortablejs";
  import { getContext, onDestroy } from "svelte";
  import { Keymap, Notice, Platform, type PaneType, TFile } from "obsidian";

  import { activeFile } from "../stores";
  import { drafts, pluginSettings, selectedDraft } from "src/model/stores";
  import SortableList from "../sortable/SortableList.svelte";
  import type { IndentedScene, MultipleSceneDraft } from "src/model/types";
  import Disclosure from "../components/Disclosure.svelte";
  import { formatSceneNumber, numberScenes } from "src/model/draft-utils";
  import type { UndoManager } from "src/view/undo/undo-manager";
  import { cloneDeep } from "lodash";
  import { scenePath } from "src/model/scene-navigation";
  import { selectElementContents, useApp } from "../utils";
  import { addAll, addScene, ignoreAll, ignoreScene } from "./scene-menu-items";

  const app = useApp();

  let currentDraftIndex: number = -1;
  $: if ($selectedDraft) {
    currentDraftIndex = $drafts.findIndex(
      (d) => d.vaultPath === $selectedDraft.vaultPath
    );
  }

  // Function to make paths from scene names
  const makeScenePath: (draft: MultipleSceneDraft, scene: string) => string =
    getContext("makeScenePath");

  // Map current list of scenes to data for our sortable list
  type SceneItem = {
    id: string;
    name: string;
    path: string;
    indent: number;
    collapsible: boolean;
    hidden: boolean;
    numbering: number[];
    status: string | undefined;
  };
  let items: SceneItem[];
  let collapsedItems: string[] = [];
  $: {
    items =
      $selectedDraft && $selectedDraft.format === "scenes"
        ? itemsFromScenes($selectedDraft.scenes, collapsedItems)
        : [];
  }

  // INDENTATION & COLLAPSING
  let ghostIndent = 0;
  let draggingIndent = 0;
  let draggingID: string = null;

  function itemsFromScenes(
    indentedScenes: IndentedScene[],
    _collapsedItems: string[]
  ): SceneItem[] {
    const scenes = numberScenes(indentedScenes);
    const itemsToReturn: SceneItem[] = [];
    let ignoringUntilIndent = Infinity;

    scenes.forEach(({ title, indent, numbering }, index) => {
      const hidden = indent > ignoringUntilIndent;
      if (!hidden) {
        ignoringUntilIndent = Infinity;
      }

      const collapsed = _collapsedItems.contains(title);
      if (collapsed) {
        ignoringUntilIndent = Math.min(ignoringUntilIndent, indent);
      }

      const nextScene = index < scenes.length - 1 ? scenes[index + 1] : false;
      const path = makeScenePath($selectedDraft as MultipleSceneDraft, title);
      const file = app.vault.getAbstractFileByPath(path);
      let status = undefined;
      if (file && file instanceof TFile) {
        const metadata = app.metadataCache.getFileCache(file);
        if (
          metadata &&
          metadata.frontmatter &&
          metadata.frontmatter["status"]
        ) {
          status = `${metadata.frontmatter["status"]}`;
        }
      }
      const item = {
        id: title,
        name: title,
        indent,
        path,
        collapsible: nextScene && nextScene.indent > indent,
        hidden,
        numbering,
        status,
      };
      itemsToReturn.push(item);
    });

    return itemsToReturn;
  }

  // Track sort state for styling, set sorting options
  let isSorting = false;
  const sortableOptions: Sortable.Options = {
    animation: 150,
    ghostClass: "scene-drag-ghost",
    chosenClass: "scene-drag-chosen",
    dragClass: "scene-drag-dragging",
    fallbackClass: "scene-drag-fallback",
    onStart: () => {
      isSorting = true;
    },
    onEnd: () => {
      isSorting = false;
    },
  };

  function itemOrderChanged(event: CustomEvent<SceneItem[]>) {
    if (currentDraftIndex >= 0 && $selectedDraft.format === "scenes") {
      const scenes: IndentedScene[] = event.detail.map((d) => ({
        title: d.name,
        indent: d.name === draggingID ? draggingIndent : d.indent,
      }));
      ($drafts[currentDraftIndex] as MultipleSceneDraft).scenes = scenes;

      sceneHistory = [
        {
          draftVaultPath: $drafts[currentDraftIndex].vaultPath,
          scenes: cloneDeep(scenes),
        },
        ...sceneHistory,
      ].slice(0, 20);
      undoIndex = 0;

      if ($activeFile) {
        onSceneClick($activeFile.path, false);
      }
    }
  }

  function itemIndentChanged(
    event: CustomEvent<{
      itemID: string;
      itemIndex: number;
      newIndent: number;
      indentWidth: number;
    }>
  ) {
    draggingID = event.detail.itemID;
    draggingIndent = event.detail.newIndent || 0;
    ghostIndent = draggingIndent * event.detail.indentWidth;
  }

  function collapseItem(itemID: string) {
    if (!collapsedItems.contains(itemID)) {
      collapsedItems = [...collapsedItems, itemID];
    } else {
      collapsedItems = collapsedItems.filter((i) => i !== itemID);
    }
  }

  // Grab the click context function and call it when a valid scene is clicked.
  const onSceneClick: (path: string, paneType: boolean | PaneType) => void =
    getContext("onSceneClick");
  function onItemClick(item: any, event: MouseEvent) {
    const sceneItem = item as SceneItem;
    if (sceneItem.path) {
      // If on mobile, treat a tap on the active file as a collapse action
      // this is because the disclosure target is way too small to tap.
      if (
        Platform.isMobile &&
        sceneItem.collapsible &&
        sceneItem.path === $activeFile.path
      ) {
        collapseItem(item.id);
      } else {
        onSceneClick(sceneItem.path, Keymap.isModEvent(event));
      }
    }
  }

  // Context click and inline editing.
  // editingPath is the item.path of the currently-context-clicked scene, or null if none clicked.
  let editingPath: string | null = null;
  // originalName is the original scene name of the scene whose path is editingPath.
  let originalName: string | null = null;

  const onContextClick: (
    path: string,
    x: number,
    y: number,
    onRename: () => void
  ) => void = getContext("onContextClick");
  function onContext(event: MouseEvent) {
    // Don't show context menu on mobile, as it blocks scene drag-and-drop.
    if (Platform.isMobileApp) {
      return;
    }
    const { x, y } = event;
    let element = document.elementFromPoint(x, y);
    // If the scene name has been right-clicked grab the parent instead.
    if (element.id.startsWith("longform-scene-")) {
      element = element.parentElement;
    }
    const scenePath =
      element && element instanceof HTMLElement && element.dataset.scenePath;
    if (!scenePath) {
      return;
    }
    onContextClick(scenePath, x, y, () => {
      if (element && element instanceof HTMLElement) {
        const path = element.dataset.scenePath;
        editingPath = path;
        const innerElement = activeDocument.querySelector(
          `[data-item-path='${path}']`
        );
        if (!(innerElement instanceof HTMLElement)) {
          return;
        }
        originalName = innerElement.dataset.itemName;
        setTimeout(() => selectElementContents(innerElement), 0);
      }
    });
  }

  function onKeydown(event: KeyboardEvent) {
    if (
      editingPath &&
      event.target instanceof HTMLElement &&
      $selectedDraft.format === "scenes"
    ) {
      const newName = event.target.innerText;
      if (event.key === "Enter") {
        // Rename file
        const newPath = scenePath(newName, $selectedDraft, app.vault);
        const file = app.vault.getAbstractFileByPath(editingPath);
        app.fileManager.renameFile(file, newPath);
        editingPath = null;
        originalName = null;
        return false;
      } else if (event.key === "Escape") {
        event.target.blur();
        return false;
      }
    }
    return true;
  }

  function onBlur(event: FocusEvent) {
    if (event.target instanceof HTMLElement) {
      event.target.innerText = originalName;
    }
    editingPath = null;
    originalName = null;
  }

  function doWithUnknown(fileName: string, action: "add" | "ignore") {
    if (!$selectedDraft) return;
    if (action === "add") {
      addScene(fileName);
    } else {
      ignoreScene(fileName);
    }
  }

  function doWithAll(action: "add" | "ignore") {
    if (!$selectedDraft) return;
    if (action === "add") {
      addAll();
    } else {
      ignoreAll();
    }
  }

  function numberLabel(item: any): string {
    return formatSceneNumber(item.numbering as number[]);
  }

  // Undo/Redo
  const undoManager = getContext("undoManager") as UndoManager;
  // Stack of scenes plus their associated draft.
  let sceneHistory: { draftVaultPath: string; scenes: IndentedScene[] }[] = [];
  // Pointer into that stack.
  let undoIndex = 0;
  undoManager.on((type, _evt, _ctx) => {
    const oldIndex = undoIndex;
    if (type === "undo") {
      // Move pointer up 1 to max of final index
      undoIndex = Math.max(Math.min(undoIndex + 1, sceneHistory.length - 1), 0);
    } else {
      // Move pointer down 1 to min of 0
      undoIndex = Math.max(undoIndex - 1, 0);
    }
    const newValue = sceneHistory[undoIndex];
    // Some final sanity checks
    if (
      oldIndex !== undoIndex &&
      newValue &&
      currentDraftIndex >= 0 &&
      newValue.draftVaultPath === $drafts[currentDraftIndex].vaultPath &&
      $drafts[currentDraftIndex].format === "scenes"
    ) {
      const newScenes = sceneHistory[undoIndex].scenes;
      ($drafts[currentDraftIndex] as MultipleSceneDraft).scenes = newScenes;

      new Notice(`${type === "undo" ? "Undid" : "Redid"} scene reordering`);
    }
    return false;
  });

  const unsubscribe = selectedDraft.subscribe((draft) => {
    if (!draft) {
      return;
    }
    sceneHistory = sceneHistory.filter(
      (s) => s.draftVaultPath === draft.vaultPath
    );
    if (
      draft.format === "scenes" &&
      (sceneHistory.length === 0 ||
        sceneHistory[0].draftVaultPath !== draft.vaultPath)
    ) {
      sceneHistory = [
        {
          draftVaultPath: draft.vaultPath,
          scenes: cloneDeep((draft as MultipleSceneDraft).scenes),
        },
      ];
      undoIndex = 0;
    }
  });

  onDestroy(unsubscribe);
</script>

<div>
  <div
    id="scene-list"
    class:dragging={isSorting}
    style="--ghost-indent: {ghostIndent}px"
  >
    <SortableList
      trackIndents
      bind:items
      let:item
      on:orderChanged={itemOrderChanged}
      on:indentChanged={itemIndentChanged}
      {sortableOptions}
      class="sortable-scene-list"
    >
      <div
        class="scene-container{item.hidden ? ' hidden' : ''}{item.collapsible ? ' collapsible' : ''}"
        style="padding-left: calc(({item.indent} * var(--longform-explorer-indent-size)) + 6px {item.collapsible ? '' : '+ var(--size-4-4)'});"
        class:selected={$activeFile && $activeFile.path === item.path}
        on:contextmenu|preventDefault={onContext}
        data-scene-path={item.path}
        data-scene-indent={item.indent}
        data-scene-name={item.name}
        data-scene-status={item.status}
      >
        {#if item.collapsible}
          <Disclosure
            collapsed={collapsedItems.contains(item.id)}
            on:click={() => {
              collapseItem(item.id);
              return false;
            }}
          />
        {/if}
        <div
          style="width: 100%;"
          data-scene-path={item.path}
          on:click={(e) =>
            typeof item.path === "string" ? onItemClick(item, e) : {}}
        >
          {#if $pluginSettings.numberScenes}
            <span class="longform-scene-number">{numberLabel(item)}</span>
          {/if}
          <div
            id={`longform-scene-${item.name}`}
            data-item-path={item.path}
            data-item-name={item.name}
            style="display: inline;"
            on:keydown={item.path === editingPath ? onKeydown : null}
            on:blur={item.path === editingPath ? onBlur : null}
            contenteditable={item.path === editingPath}
          >
            {item.name}
          </div>
        </div>
      </div>
    </SortableList>
  </div>
  {#if $selectedDraft && $selectedDraft.format === "scenes" && $selectedDraft.unknownFiles.length > 0}
    <div id="longform-unknown-files-wizard">
      <div class="longform-unknown-inner">
        <p class="longform-unknown-explanation">
          Longform has found {$selectedDraft.unknownFiles.length} new file{$selectedDraft
            .unknownFiles.length === 1
            ? ""
            : "s"} in your scenes folder.
        </p>
        <div>
          <button class="longform-unknown-add" on:click={() => doWithAll("add")}
            >Add all</button
          >
          <button
            class="longform-unknown-ignore"
            on:click={() => doWithAll("ignore")}>Ignore all</button
          >
        </div>
        <ul>
          {#each $selectedDraft.unknownFiles as fileName}
            <li>
              <div class="longform-unknown-file">
                <span>{fileName}</span>
                <div>
                  <button
                    class="longform-unknown-add"
                    on:click={() => doWithUnknown(fileName, "add")}>Add</button
                  >
                  <button
                    class="longform-unknown-ignore"
                    on:click={() => doWithUnknown(fileName, "ignore")}
                    >Ignore</button
                  >
                </div>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}
</div>

<style>
  :global(.group) {
    margin-left: var(--size-4-2);
  }

  #scene-list {
    margin: var(--size-4-1) 0;
  }

  #scene-list :global(.sortable-scene-list) {
    list-style-type: none;
    padding: 0;
    margin: 0;
  }

  .scene-container {
    display: flex;
    flex-direction: row;
    align-items: center;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-s);
    cursor: pointer;
    color: var(--nav-item-color);
    font-size: var(--nav-item-size);
    font-weight: var(--nav-item-weight);
    line-height: var(--line-height-tight);
    padding: var(--size-4-1) var(--size-4-2);
    white-space: normal;
  }

  .scene-container.collapsible {
    display: flex;
    flex-direction: row;
    align-items: center;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-s);
    cursor: pointer;
    color: var(--nav-item-color);
    font-size: var(--nav-item-size);
    font-weight: var(--nav-item-weight);
    line-height: var(--line-height-tight);
    padding: var(--size-4-1) var(--size-4-2);
    white-space: normal;
  }

  .scene-container.hidden {
    display: none;
  }

  .scene-container *:nth-child(2) {
    margin-left: var(--size-4-2);
  }

  .selected,
  :not(.dragging) .scene-container:hover {
    background-color: var(--background-secondary-alt);
    color: var(--text-normal);
  }

  .scene-container:active {
    background-color: inherit;
    color: var(--text-muted);
  }

  .longform-scene-number {
    color: var(--text-muted);
    margin-right: var(--size-4-1);
    font-weight: bold;
  }

  .longform-scene-number::after {
    content: ".";
  }

  #longform-unknown-files-wizard {
    border-top: var(--border-width) solid var(--text-muted);
    padding: var(--size-4-2) 0;
  }

  .longform-unknown-inner {
    border-left: var(--size-2-1) solid var(--text-accent);
    padding: 0 0 0 var(--size-4-1);
  }

  .longform-unknown-explanation {
    color: var(--text-muted);
    font-size: 1em;
  }

  #longform-unknown-files-wizard ul {
    list-style-type: none;
    padding: 0 0 0 var(--size-4-2);
  }

  .longform-unknown-file {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
  }

  .longform-unknown-add {
    color: var(--text-accent);
    font-weight: bold;
  }

  .longform-unknown-ignore {
    color: var(--text-muted);
    font-weight: bold;
  }

  :global(.scene-drag-ghost) {
    background-color: var(--interactive-accent-hover);
    color: var(--text-on-accent);
    margin-left: var(--ghost-indent);
  }
</style>
