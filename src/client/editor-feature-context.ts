import { createContext } from "react";
import type { ClientMemberContext } from "../shared/types";

export const EditorFeatureContext = createContext<{
  hostId: string;
  member: ClientMemberContext;
  onSelectPage: (id: string) => void;
} | null>(null);
