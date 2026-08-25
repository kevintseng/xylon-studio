import { type NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  if (process.env.XYLON_SHOW_FEATURES === 'false') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/openroad/:path*', '/pipeline/:path*'],
}
