export function getRovingTabTargetIndex(currentIndex: number, key: string, itemCount: number): number | null {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return null
  if (
    (key === 'ArrowRight' || key === 'ArrowLeft')
    && (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= itemCount)
  ) {
    return null
  }

  switch (key) {
    case 'ArrowRight':
      return currentIndex + 1
    case 'ArrowLeft':
      return currentIndex - 1
    case 'Home':
      return 0
    case 'End':
      return itemCount - 1
    default:
      return null
  }
}
