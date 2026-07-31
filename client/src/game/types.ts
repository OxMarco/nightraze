/** Shape returned by GET /leaderboard (mirrors LeaderboardEntry on the server). */
export interface LeaderboardEntry {
  id: number;
  name: string;
  light: number;
  rank: number;   // position on the full ladder, not the index within this list
}
