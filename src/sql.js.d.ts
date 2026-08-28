declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => {
      prepare(sql: string): {
        bind(params: unknown[]): void;
        step(): boolean;
        getAsObject(): Record<string, unknown>;
      };
      close(): void;
    };
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
