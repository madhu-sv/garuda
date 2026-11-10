# The Homebrew formula for the tap madhu-sv/homebrew-garuda (file Formula/garuda.rb there).
# It installs the npm package. For each release, set `url` to the new version and `sha256` to the
# hash of that tarball: see docs/release.md.
class Garuda < Formula
  desc "Terminal coding agent with an OS sandbox, approvals and an audit log"
  homepage "https://madhu-sv.github.io/garuda/"
  url "https://registry.npmjs.org/@garuda-agent/garuda/-/garuda-0.20.0.tgz"
  sha256 "ca00c1434905b58e1a1398e94b099452f75f2030ed775d206eed73e6cd172807"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    on_linux do
      <<~EOS
        The OS sandbox on Linux needs bubblewrap (bwrap), for example:
          sudo apt install bubblewrap
        Without it, Garuda asks before each command.
      EOS
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/garuda --version")
  end
end
