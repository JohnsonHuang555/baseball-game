/** 壘包狀態小菱形：有人的壘亮黃燈（首頁的目前比賽、觀戰畫面的比分板共用） */
export function basesSvg(on: readonly boolean[]): string {
  const fill = (i: number) => (on[i] ? '#FFD23F' : '#FFFFFF')
  return `<svg aria-hidden="true" viewBox="0 0 54 38">
    <rect x="20" y="3" width="14" height="14" rx="2" transform="rotate(45 27 10)" fill="${fill(1)}" stroke="#141633" stroke-width="2"/>
    <rect x="35" y="18" width="14" height="14" rx="2" transform="rotate(45 42 25)" fill="${fill(0)}" stroke="#141633" stroke-width="2"/>
    <rect x="5" y="18" width="14" height="14" rx="2" transform="rotate(45 12 25)" fill="${fill(2)}" stroke="#141633" stroke-width="2"/>
  </svg>`
}
