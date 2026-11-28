"use client";
import { useState } from "react";
import { useTiptapEditor } from "@/app/components/tiptap/hooks/use-tiptap-editor";
import { ChevronDownIcon } from "@/app/components/tiptap/tiptap-icons/chevron-down-icon";
import { Button } from "@/app/components/tiptap/tiptap-ui-primitive/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/app/components/tiptap/tiptap-ui-primitive/dropdown-menu";
import { fieldNode, type EmailField } from "./email-nodes";

/**
 * Insert field: the template's dropdown menu (as its list menu is drawn), listing the email's fields with their sample
 * values; choosing one puts it in where the cursor is, as typing "{" does.
 */
export function InsertFieldMenu({ fields }: { fields: EmailField[] }) {
  const { editor } = useTiptapEditor();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" data-state={open ? "open" : "closed"} disabled={!editor} aria-label="Insert field" tooltip="Insert field">
          <span className="tiptap-button-text">Insert field</span>
          <ChevronDownIcon className="tiptap-button-dropdown-small" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {fields.map((f) => (
            <DropdownMenuItem key={f.id} asChild>
              <Button type="button" variant="ghost" className="rte-field-choice"
                onClick={() => editor?.chain().focus().insertContent([fieldNode({ id: f.id, label: f.label }), { type: "text", text: " " }]).run()}>
                <span className="tiptap-button-text">{f.label}</span>
                <span className="rte-field-sample">{f.sample}</span>
              </Button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
