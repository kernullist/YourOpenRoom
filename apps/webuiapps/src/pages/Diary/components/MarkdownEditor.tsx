import React, { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';

// tiptap-markdown 0.9.0 ships MarkdownStorage but does not augment the core
// Storage interface, so editor.storage.markdown is otherwise untyped. Declare
// the augmentation here (page-local) instead of touching shared type files.
declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

interface MarkdownEditorProps {
  content: string;
  placeholder?: string;
  onChange: (markdown: string) => void;
  className?: string;
}

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  content,
  placeholder = '',
  onChange,
  className,
}) => {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track whether this is an external content update (not user input)
  const isExternalUpdate = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: {
          HTMLAttributes: { class: 'md-code-block' },
        },
        code: {
          HTMLAttributes: { class: 'md-inline-code' },
        },
        blockquote: {
          HTMLAttributes: { class: 'md-blockquote' },
        },
        bulletList: {
          HTMLAttributes: { class: 'md-bullet-list' },
        },
        orderedList: {
          HTMLAttributes: { class: 'md-ordered-list' },
        },
        horizontalRule: {
          HTMLAttributes: { class: 'md-hr' },
        },
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: 'is-editor-empty',
      }),
      Markdown.configure({
        html: false,
        transformCopiedText: true,
        transformPastedText: true,
      }),
    ],
    content,
    onUpdate: ({ editor: ed }) => {
      if (isExternalUpdate.current) return;
      const md = ed.storage.markdown.getMarkdown();
      onChangeRef.current(md);
    },
    editorProps: {
      attributes: {
        class: 'md-editor-content',
        spellcheck: 'false',
      },
    },
  });

  // Sync to editor when external content changes (e.g., Agent update, switching diary entry)
  useEffect(() => {
    if (!editor) return;
    const currentMd = editor.storage.markdown.getMarkdown();
    if (currentMd !== content) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content);
      isExternalUpdate.current = false;
    }
  }, [content, editor]);

  return <EditorContent editor={editor} className={className} />;
};

export default React.memo(MarkdownEditor);
