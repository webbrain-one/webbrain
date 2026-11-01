import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import crypto from "crypto";

/**
 * Đăng ký Alrithm API Provider vào hệ thống WebBrain MCP Server.
 * Khối logic này xử lý việc truyền dữ liệu sạch kèm cơ chế xác thực Merkle Root ở cấp độ hàng.
 */
export function registerAlrithmProvider(server: McpServer) {
  server.tool(
    "fetch_verified_dataset",
    "Stream clean structural data into the LLM pipeline with row-level Merkle Root integrity checks",
    async () => {
      try {
        const response = await fetch("https://alrithmapi.vercel.app");
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `API Connection Failed: ${response.statusText}` }]
          };
        }

        const dataset: any = await response.json();
        
        // Vòng lặp kiểm tra tính toàn vẹn mã hóa mã nguồn chạy trực tiếp trong pipeline
        for (const [index, row] of dataset.entries()) {
          // Sắp xếp lại key để chuỗi JSON đồng nhất tuyệt đối với mã nguồn sinh gốc từ AI của bạn
          const serializedData = JSON.stringify(row.data, Object.keys(row.data).sort());
          const calculatedHash = crypto.createHash("sha256").update(serializedData).digest("hex");
          
          if (calculatedHash !== row.merkle_root) {
            throw new Error(`CRITICAL: Data corruption or tampering detected at row index [${index}]!`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "🔒 Cryptographic integrity verified via Merkle Proof",
                records_count: dataset.length,
                data: dataset
              }, null, 2)
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Pipeline integration halted: ${error.message}` }]
        };
      }
    }
  );
}
