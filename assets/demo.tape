# README demo body. Build the final GIF (title card + this) with: sh assets/demo-render.sh
Output assets/demo-body.mp4
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
Set TypingSpeed 18ms
Set WindowBar Colorful

Hide
Type "source assets/demo-setup.sh"
Enter
Wait+Screen@30s /\$/
Show

Type "skilladopt add DietrichGebert/ponytail/.openclaw/skills/ponytail"
Enter
Sleep 400ms
Hide
Wait+Screen@240s /next/
Show
Sleep 4500ms

Type "skilladopt review last --decide all=accept"
Enter
Wait+Screen@20s /apply/
Sleep 800ms
Type "skilladopt apply last"
Enter
Wait+Screen@30s /adopted/
Sleep 1500ms

Hide
Type "teammate; clear"
Enter
Sleep 1s
Show
Type "# A week later, a teammate changed the test script and added a rule:"
Enter
Type `grep '"test"' package.json; tail -1 AGENTS.md`
Enter
Sleep 2s
Type "skilladopt impact"
Enter
Wait+Screen@30s /need a look/
Sleep 7s
