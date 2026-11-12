import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/agentAccessPolicy";

export const messages = {
  "error.agentAccessPolicy.invalid": "Este cambio en el grupo de agentes no es válido.",
  "error.agentAccessPolicy.stale": "Los permisos del agente cambiaron. Vuelve a revisar los cambios.",
  "error.agentAccessPolicy.busy": "Espera a que estos agentes queden libres: {agents}.",
  "error.agentAccessPolicy.forbidden":
    "Solo los propietarios y administradores pueden gestionar los grupos de agentes.",
  "error.agentAccessPolicy.connectionDenied": "Este agente no puede usar esta conexión MCP.",
  "error.agentAccessPolicy.refresh": "Se guardaron los permisos. Espera a que el agente actualice sus conexiones.",
  "error.agentAccessPolicy.storage": "No se pudieron leer o guardar los permisos del agente.",
} as const satisfies PartialTranslation<typeof source>;
