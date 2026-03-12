import fs from "node:fs";
import net from "node:net";
import { loadExecApprovals } from "./exec-approvals.js";

/**
 * Exec Approvals Socket Server
 *
 * Creates a Unix socket server that handles approval requests from the Gateway.
 * When a command needs approval, the Gateway sends a request via this socket,
 * and the response (approve/deny) is returned.
 */
export class ExecApprovalsSocketServer {
  private server: net.Server | null = null;
  private socketPath: string = "";
  private token: string = "";
  private pendingRequests: Map<
    string,
    {
      resolve: (result: boolean | null) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  /**
   * Start the socket server
   */
  async start(): Promise<void> {
    const config = loadExecApprovals();

    if (!config.socket?.path) {
      console.log("[ExecApprovalsSocketServer] Socket not configured, skipping");
      return;
    }

    const socketPath = config.socket.path;
    const token = config.socket.token || "";

    // Remove existing socket file if present
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err) => {
        console.error("[ExecApprovalsSocketServer] Server error:", err);
        reject(err);
      });

      this.server.listen(socketPath, () => {
        // Set socket permissions to allow access
        try {
          fs.chmodSync(socketPath, "666");
        } catch {
          // Ignore chmod errors
        }
        console.log(`[ExecApprovalsSocketServer] Listening on ${socketPath}`);
        this.socketPath = socketPath;
        this.token = token;
        resolve();
      });
    });
  }

  /**
   * Stop the socket server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log("[ExecApprovalsSocketServer] Stopped");
          this.server = null;

          // Clean up socket file
          if (this.socketPath && fs.existsSync(this.socketPath)) {
            try {
              fs.unlinkSync(this.socketPath);
            } catch {
              // Ignore cleanup errors
            }
          }

          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming socket connection
   */
  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString("utf8");

      // Process complete lines (JSON messages)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        this.handleMessage(socket, line);
      }
    });

    socket.on("error", (err) => {
      console.error("[ExecApprovalsSocketServer] Connection error:", err);
    });
  }

  /**
   * Handle incoming JSON message
   */
  private handleMessage(socket: net.Socket, messageStr: string): void {
    try {
      const message = JSON.parse(messageStr);

      // Validate token
      if (this.token && message.token !== this.token) {
        this.sendResponse(socket, message.requestId, { error: "Invalid token" });
        return;
      }

      // Handle approval request
      if (message.type === "approval_request") {
        void this.handleApprovalRequest(socket, message);
      } else if (message.type === "approval_response") {
        this.handleApprovalResponse(message);
      } else {
        this.sendResponse(socket, message.requestId, { error: "Unknown message type" });
      }
    } catch (err) {
      console.error("[ExecApprovalsSocketServer] Failed to parse message:", err);
      this.sendResponse(socket, "unknown", { error: "Invalid JSON" });
    }
  }

  /**
   * Handle approval request - forward to user for decision
   */
  private async handleApprovalRequest(
    socket: net.Socket,
    message: {
      requestId: string;
      command: string;
      reason?: string;
    },
  ): Promise<void> {
    // For now, auto-deny with a clear message
    // In a full implementation, this would show a UI to the user
    console.log(`[ExecApprovalsSocketServer] Approval request: ${message.command}`);

    // Auto-deny for now (as there's no UI implemented)
    this.sendResponse(socket, message.requestId, {
      approved: false,
      reason:
        "Socket server started but approval UI not implemented. Use Telegram/Discord for approvals.",
    });
  }

  /**
   * Handle approval response (from external UI)
   */
  private handleApprovalResponse(message: {
    requestId: string;
    approved: boolean;
    reason?: string;
  }): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(message.approved);
      this.pendingRequests.delete(message.requestId);
    }
  }

  /**
   * Send response back via socket
   */
  private sendResponse(socket: net.Socket, requestId: string, response: object): void {
    const message = JSON.stringify({
      requestId,
      ...response,
    });
    socket.write(`${message}\n`);
  }

  /**
   * Request approval via socket (called by Gateway)
   */
  async requestApproval(command: string, timeoutMs: number = 60000): Promise<boolean | null> {
    if (!this.socketPath || !fs.existsSync(this.socketPath)) {
      console.log(`[ExecApprovalsSocketServer] Socket not available, cannot request approval`);
      return null;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const client = new net.Socket();

      const timeout = setTimeout(() => {
        client.destroy();
        this.pendingRequests.delete(requestId);
        resolve(null); // Timeout = no approval
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, timeout });

      client.connect(this.socketPath, () => {
        const message = JSON.stringify({
          type: "approval_request",
          requestId,
          token: this.token,
          command,
        });
        client.write(`${message}\n`);
      });

      client.on("error", () => {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        resolve(null);
      });

      client.on("data", (data) => {
        try {
          const response = JSON.parse(data.toString().trim());
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          client.destroy();
          resolve(response.approved ?? null);
        } catch {
          // Ignore parse errors
        }
      });
    });
  }
}

// Singleton instance
let socketServer: ExecApprovalsSocketServer | null = null;

/**
 * Get or create the socket server instance
 */
export function getExecApprovalsSocketServer(): ExecApprovalsSocketServer {
  if (!socketServer) {
    socketServer = new ExecApprovalsSocketServer();
  }
  return socketServer;
}

/**
 * Start the exec approvals socket server
 */
export async function startExecApprovalsSocketServer(): Promise<void> {
  await getExecApprovalsSocketServer().start();
}

/**
 * Stop the exec approvals socket server
 */
export async function stopExecApprovalsSocketServer(): Promise<void> {
  if (socketServer) {
    await socketServer.stop();
    socketServer = null;
  }
}
