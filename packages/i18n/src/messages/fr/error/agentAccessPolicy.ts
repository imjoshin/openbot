import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/agentAccessPolicy";

export const messages = {
  "error.agentAccessPolicy.invalid": "Cette modification du groupe d’agents est invalide.",
  "error.agentAccessPolicy.stale": "Les autorisations des agents ont changé. Vérifiez à nouveau les modifications.",
  "error.agentAccessPolicy.busy": "Attendez que ces agents soient disponibles : {agents}.",
  "error.agentAccessPolicy.forbidden":
    "Seuls les propriétaires et les administrateurs peuvent gérer les groupes d’agents.",
  "error.agentAccessPolicy.connectionDenied": "Cet agent ne peut pas utiliser cette connexion MCP.",
  "error.agentAccessPolicy.refresh": "Autorisations enregistrées. Attendez que l’agent actualise ses connexions.",
  "error.agentAccessPolicy.storage": "Impossible de lire ou d’enregistrer les autorisations des agents.",
} as const satisfies PartialTranslation<typeof source>;
