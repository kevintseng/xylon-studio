import { type NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_SHOW_FEATURES === 'false') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/openroad/:path*', '/pipeline/:path*'],
}
