import { AmpDashboard } from './_components/AmpDashboard'
import { EasterEggCelebration } from './_components/EasterEggCelebration'

export default function Page() {
  return (
    <>
      <header className="sr-only">
        <h1>Amplified Dashboard — Live Revenue, Treasury & Rev Share Stats</h1>
        <p>
          Amplified is a Telegram bot for 2–10x leverage trading on crypto and
          prediction markets on Solana. This dashboard shows live fee-wallet
          revenue, treasury balance, user payouts, weekly rev share accrual,
          and a rev share calculator for $AMP token holders. Site:
          ampsrev.xyz.
        </p>
      </header>
      <AmpDashboard />
      <EasterEggCelebration />
    </>
  )
}
