export interface IConfig {
  autorefresh: boolean;
  consolidateUnrealOneFilePerActorChanges: boolean;
  cmConfiguration: IShellConfig;
  enabled: boolean;
  /** Top-level directory names whose churn must not trigger a status refresh. */
  ignoredDirectories: string[];
  history: IHistoryConfig;
}

export interface IShellConfig {
  cmPath: string;
  millisToStop: number;
  millisToWaitUntilUp: number;
  millisCommandTimeout: number;
}

export interface IHistoryConfig {
  /** Changesets fetched per branch lane on each page of the Plastic SCM Graph view. */
  pageSize: number;
}
