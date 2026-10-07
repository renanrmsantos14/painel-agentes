// O bundle do Design System lê o React de window.React; este módulo precisa ser importado antes dele.
import React from 'react'

;(window as unknown as { React: typeof React }).React = React
