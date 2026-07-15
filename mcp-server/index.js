#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import http from "http";
import { exec } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, "oauth_credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const OAUTH_PORT = 3456;

function openBrowser(url) {
  const opener =
    process.platform === "win32"
      ? "start \"\""
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  exec(`${opener} "${url}"`);
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const redirectUri = `http://localhost:${OAUTH_PORT}/oauth2callback`;
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      redirect_uri: redirectUri,
    });

    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith("/oauth2callback")) {
        res.end();
        return;
      }
      const qs = new URL(req.url, redirectUri).searchParams;
      const code = qs.get("code");
      const err = qs.get("error");
      if (err) {
        res.end(`❌ 인증 실패: ${err}`);
        server.close();
        reject(new Error(err));
        return;
      }
      res.end("✅ 인증 완료! 이 창을 닫으셔도 됩니다.");
      server.close();
      try {
        const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: redirectUri });
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        resolve(oAuth2Client);
      } catch (e) {
        reject(e);
      }
    });

    server.listen(OAUTH_PORT, () => {
      console.error(`브라우저에서 Google 계정 인증을 진행하세요. 자동으로 열리지 않으면 다음 URL을 여세요:\n${authUrl}`);
      openBrowser(authUrl);
    });
  });
}

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_secret, client_id } = credentials.installed;
  const redirectUri = `http://localhost:${OAUTH_PORT}/oauth2callback`;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oAuth2Client.setCredentials(token);
    oAuth2Client.on("tokens", (tokens) => {
      const merged = { ...token, ...tokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged));
    });
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

let sheetsClientPromise;
function getSheets() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = authorize().then((auth) => google.sheets({ version: "v4", auth }));
  }
  return sheetsClientPromise;
}

const TOOLS = [
  {
    name: "get_spreadsheet_info",
    description: "스프레드시트의 시트 목록·행/열 크기 정보를 가져옵니다",
    inputSchema: {
      type: "object",
      properties: { spreadsheet_id: { type: "string" } },
      required: ["spreadsheet_id"],
    },
  },
  {
    name: "read_sheet",
    description: "지정한 범위(A1 표기)의 셀 데이터를 읽습니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string", description: "예: 'Sheet1!A1:D10'" },
      },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "batch_read_sheet",
    description: "여러 범위를 한 번의 API 호출로 읽습니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        ranges: { type: "array", items: { type: "string" } },
      },
      required: ["spreadsheet_id", "ranges"],
    },
  },
  {
    name: "write_sheet",
    description: "지정한 범위에 값을 덮어씁니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
        values: { type: "array", items: { type: "array" } },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
  },
  {
    name: "append_sheet",
    description: "시트 끝에 행을 추가합니다 (기존 데이터 유지)",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
        values: { type: "array", items: { type: "array" } },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
  },
  {
    name: "clear_sheet",
    description: "지정한 범위의 값을 삭제합니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
      },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "add_sheet",
    description: "새 시트 탭을 추가합니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        title: { type: "string" },
      },
      required: ["spreadsheet_id", "title"],
    },
  },
  {
    name: "delete_sheet",
    description: "시트 탭을 삭제합니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        sheet_id: { type: "number" },
      },
      required: ["spreadsheet_id", "sheet_id"],
    },
  },
  {
    name: "create_spreadsheet",
    description: "새 스프레드시트 파일을 생성합니다",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        sheet_titles: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "format_cells",
    description: "셀 서식(배경색·글자색·굵게)을 적용합니다",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        sheet_id: { type: "number" },
        start_row: { type: "number" },
        end_row: { type: "number" },
        start_col: { type: "number" },
        end_col: { type: "number" },
        background_color: {
          type: "object",
          properties: { red: { type: "number" }, green: { type: "number" }, blue: { type: "number" } },
        },
        text_color: {
          type: "object",
          properties: { red: { type: "number" }, green: { type: "number" }, blue: { type: "number" } },
        },
        bold: { type: "boolean" },
      },
      required: ["spreadsheet_id", "sheet_id", "end_row", "end_col"],
    },
  },
];

const server = new Server(
  { name: "google-sheets", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const sheets = await getSheets();
    switch (name) {
      case "get_spreadsheet_info": {
        const res = await sheets.spreadsheets.get({ spreadsheetId: args.spreadsheet_id });
        const info = res.data.sheets.map((s) => ({
          title: s.properties.title,
          sheetId: s.properties.sheetId,
          rows: s.properties.gridProperties?.rowCount,
          cols: s.properties.gridProperties?.columnCount,
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify({ title: res.data.properties.title, sheets: info }, null, 2) },
          ],
        };
      }
      case "read_sheet": {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: args.spreadsheet_id, range: args.range });
        return { content: [{ type: "text", text: JSON.stringify(res.data.values || [], null, 2) }] };
      }
      case "batch_read_sheet": {
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: args.spreadsheet_id,
          ranges: args.ranges,
        });
        return { content: [{ type: "text", text: JSON.stringify(res.data.valueRanges, null, 2) }] };
      }
      case "write_sheet": {
        await sheets.spreadsheets.values.update({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: args.values },
        });
        return { content: [{ type: "text", text: "✅ 기록 완료" }] };
      }
      case "append_sheet": {
        await sheets.spreadsheets.values.append({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: args.values },
        });
        return { content: [{ type: "text", text: "✅ 행 추가 완료" }] };
      }
      case "clear_sheet": {
        await sheets.spreadsheets.values.clear({ spreadsheetId: args.spreadsheet_id, range: args.range });
        return { content: [{ type: "text", text: "✅ 삭제 완료" }] };
      }
      case "add_sheet": {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: { requests: [{ addSheet: { properties: { title: args.title } } }] },
        });
        return { content: [{ type: "text", text: JSON.stringify(res.data.replies[0].addSheet.properties, null, 2) }] };
      }
      case "delete_sheet": {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: { requests: [{ deleteSheet: { sheetId: args.sheet_id } }] },
        });
        return { content: [{ type: "text", text: "✅ 시트 삭제 완료" }] };
      }
      case "create_spreadsheet": {
        const sheetTitles = args.sheet_titles && args.sheet_titles.length ? args.sheet_titles : ["Sheet1"];
        const res = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: args.title },
            sheets: sheetTitles.map((title) => ({ properties: { title } })),
          },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { spreadsheetId: res.data.spreadsheetId, url: res.data.spreadsheetUrl },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "format_cells": {
        const cellFormat = {};
        const fields = [];
        if (args.background_color) {
          cellFormat.backgroundColor = args.background_color;
          fields.push("userEnteredFormat.backgroundColor");
        }
        if (args.bold !== undefined || args.text_color) {
          cellFormat.textFormat = {};
          if (args.bold !== undefined) {
            cellFormat.textFormat.bold = args.bold;
            fields.push("userEnteredFormat.textFormat.bold");
          }
          if (args.text_color) {
            cellFormat.textFormat.foregroundColor = args.text_color;
            fields.push("userEnteredFormat.textFormat.foregroundColor");
          }
        }
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: args.sheet_id,
                    startRowIndex: args.start_row ?? 0,
                    endRowIndex: args.end_row,
                    startColumnIndex: args.start_col ?? 0,
                    endColumnIndex: args.end_col,
                  },
                  cell: { userEnteredFormat: cellFormat },
                  fields: fields.join(","),
                },
              },
            ],
          },
        });
        return { content: [{ type: "text", text: "✅ 서식 적용 완료" }] };
      }
      default:
        throw new Error(`알 수 없는 도구: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: "text", text: `❌ 오류: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
