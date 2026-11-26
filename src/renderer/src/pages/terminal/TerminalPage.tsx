import { Navbar } from '@renderer/components/app/Navbar'
import { isMac } from '@renderer/config/constant'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { FC } from 'react'
import styled from 'styled-components'

import { TerminalWorkbench } from './TerminalWorkbench'

const TerminalPage: FC = () => {
  const isFullscreen = useFullscreen()

  return (
    <Page>
      {isMac && !isFullscreen && <Navbar />}
      <TerminalWorkbench />
    </Page>
  )
}

const Page = styled.main`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
`

export default TerminalPage
