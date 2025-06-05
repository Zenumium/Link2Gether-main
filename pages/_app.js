import Head from 'next/head'
import '../styles/globals.css'

function MyApp({ Component, pageProps }) {
  return (
    <>
      <Head>
        <link rel="icon" href="/Link2Gether_Favicon.png" />
      </Head>
      <Component {...pageProps} />
    </>
  )
}

export default MyApp
