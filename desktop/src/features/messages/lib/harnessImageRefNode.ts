import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

/**
 * LOCAL DIVERGENCE: an attached image named in a harness prompt (mage's
 * `@image1`, `@image2`…), shown as its thumbnail and "Image N". It points at
 * an upload by its original URL (a Draw on image replacement keeps it); `index`
 * is that upload's place among the attached images,
 * kept current by `syncImageRefsTransaction`. Plain text and markdown both
 * read `@image{index}`, so the send path and the agent see the reference.
 */

export const HARNESS_IMAGE_REF_NODE_NAME = "harnessImageRef";

/** `url` is the upload's original URL, which a Draw on image keeps. */
export type AttachedImage = { url: string; thumb: string };

export function imageRefText(index: number): string {
  return `@image${index}`;
}

/** Editor content for the reference to `images[at]`, then a space. */
export function imageRefContent(images: readonly AttachedImage[], at: number) {
  return [
    {
      type: HARNESS_IMAGE_REF_NODE_NAME,
      attrs: { url: images[at].url, index: at + 1, thumb: images[at].thumb },
    },
    { type: "text", text: " " },
  ];
}

export const HarnessImageRefNode = Node.create({
  name: HARNESS_IMAGE_REF_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      url: { default: "" },
      index: { default: 1 },
      thumb: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-harness-image-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const index = Number(node.attrs.index) || 1;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-harness-image-ref": "",
        "data-index": String(index),
        contenteditable: "false",
        class:
          "mx-0.5 inline-flex h-6 items-center gap-1 rounded-md border border-border/60 bg-muted/60 py-0.5 pl-0.5 pr-1.5 align-middle text-sm",
      }),
      [
        "img",
        {
          alt: "",
          src: String(node.attrs.thumb ?? ""),
          draggable: "false",
          class: "h-5 w-5 rounded-[4px] object-cover",
        },
      ],
      ["span", {}, `Image ${index}`],
    ];
  },

  renderText({ node }) {
    return imageRefText(Number(node.attrs.index) || 1);
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          // biome-ignore lint/suspicious/noExplicitAny: prosemirror-markdown state is untyped here
          state: any,
          // biome-ignore lint/suspicious/noExplicitAny: PM node
          node: any,
        ) {
          state.write(imageRefText(Number(node.attrs.index) || 1));
        },
      },
    };
  },
});

/**
 * Renumbers each image reference after the attachments changed, and deletes
 * those whose upload is gone. Null when nothing changed.
 */
export function syncImageRefsTransaction(
  state: EditorState,
  images: readonly AttachedImage[],
): Transaction | null {
  const changes: { pos: number; node: ProseMirrorNode; at: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== HARNESS_IMAGE_REF_NODE_NAME) return true;
    const at = images.findIndex((image) => image.url === node.attrs.url);
    const current = images[at];
    if (
      at === -1 ||
      Number(node.attrs.index) !== at + 1 ||
      String(node.attrs.thumb) !== current.thumb
    ) {
      changes.push({ pos, node, at });
    }
    return false;
  });
  if (changes.length === 0) return null;
  const tr = state.tr;
  for (const { pos, node, at } of changes.reverse()) {
    if (at === -1) {
      const end = pos + node.nodeSize;
      const space =
        end < state.doc.content.size &&
        state.doc.textBetween(end, end + 1) === " ";
      tr.delete(pos, space ? end + 1 : end);
    } else {
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        index: at + 1,
        thumb: images[at].thumb,
      });
    }
  }
  return tr.setMeta("addToHistory", false);
}
