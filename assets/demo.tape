# README demo. Render from the repository root: vhs assets/demo.tape
Output assets/demo.gif
Require bash
Require node
Require git
Require codex
Set Shell "bash"
Set FontSize 18
Set Width 1400
Set Height 820
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful

Hide
Type "source assets/demo-setup.sh"
Enter
Wait+Screen@30s /\$/
Show

Type "skilladopt add DietrichGebert/ponytail/.openclaw/skills/ponytail"
Enter
Wait+Screen@30s /worker/
Sleep 2s
Hide
Wait+Screen@240s /next/
Show
Sleep 7s

Type "skilladopt review last --decide all=accept"
Enter
Wait+Screen@20s /apply/
Sleep 1500ms
Type "skilladopt apply last"
Enter
Wait+Screen@30s /adopted/
Sleep 3s

Hide
Type "teammate; clear"
Enter
Sleep 1s
Show
Type "# A week later, a teammate changed the test script and added a rule:"
Enter
Type `grep '"test"' package.json; tail -1 AGENTS.md`
Enter
Sleep 4s
Type "skilladopt impact"
Enter
Wait+Screen@30s /need a look/
Sleep 9s
