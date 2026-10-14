# frozen_string_literal: true

# Lists the locked gems whose own gemspec excludes the target Rails: the gems
# to bump or replace before the bump can resolve. Reads only the lockfile, so
# no network, no next_rails, no bundle install. Runs with the app's Ruby:
# stdlib only, Ruby 2.1 compatible.
#
#   ruby <skill>/detection-scripts/gem_limits.rb [--target 4.2] [--lockfile Gemfile.next.lock]
#
# Only limits on the Rails framework gems count. A gem only the framework pulls
# in is skipped (the next rails resolves it), and a transitive gem names the
# gems that pull it in.

require "optparse"
require "rubygems"
require_relative "hop"

FRAMEWORK_GEMS = %w[
  rails railties actionpack actionview activerecord activemodel activesupport activeresource
  actionmailer activejob actioncable activestorage actiontext actionmailbox
].freeze

# { :specs => { name => { :version, :source, :deps => { dep => [req, ...] } } }, :direct => [names] }
def parse_lockfile(text)
  specs = {}
  direct = []
  section = current = nil
  text.each_line do |line|
    line = line.chomp
    if line =~ /\A(\S.*)\z/
      section = $1.strip
      current = nil
    elsif section == "DEPENDENCIES"
      direct << $1 if line =~ /\A  ([^\s!(]+)/
    elsif %w[GEM GIT PATH].include?(section)
      if line =~ /\A    (\S+) \(([^)]+)\)\z/
        # Platform variants (nokogiri 1.6.8-x86_64-linux) are one gem: show the
        # plain version and keep every variant's requirements.
        current = (specs[$1] ||= { :version => $2, :source => section.downcase, :deps => {} })
        current[:version] = $2 unless $2.include?("-")
      elsif current && line =~ /\A      (\S+)(?: \(([^)]+)\))?\z/
        reqs = (current[:deps][$1] ||= [])
        reqs << ($2 || ">= 0") unless reqs.include?($2 || ">= 0")
      end
    end
  end
  { :specs => specs, :direct => direct }
end

# A requirement allows "4.1" when any 4.1.x patch satisfies it.
def allows_minor?(requirement, minor)
  req = Gem::Requirement.new(*requirement.split(/,\s*/))
  (0..99).any? { |patch| req.satisfied_by?(Gem::Version.new("#{minor}.#{patch}")) }
end

def capped_gems(lock, target)
  specs = lock[:specs]
  parents = Hash.new { |h, k| h[k] = [] }
  specs.each { |name, s| s[:deps].each { |dep, reqs| parents[dep] << [name, reqs.join("; ")] } }

  specs.keys.sort.map do |name|
    next if FRAMEWORK_GEMS.include?(name)
    limits = []
    specs[name][:deps].each do |dep, reqs|
      reqs.each { |req| limits << "#{dep} #{req}" if FRAMEWORK_GEMS.include?(dep) && !allows_minor?(req, target) }
    end
    next if limits.empty?
    direct = lock[:direct].include?(name)
    pulled_by = parents[name].reject { |parent, _| FRAMEWORK_GEMS.include?(parent) }
    next if !direct && pulled_by.empty?
    { :name => name, :version => specs[name][:version], :source => specs[name][:source], :direct => direct,
      :limits => limits, :parents => pulled_by.map { |parent, req| req == ">= 0" ? parent : "#{parent} (#{req})" } }
  end.compact
end

def render(hop, lockfile, capped)
  out = ["# Gem limits: Rails #{hop[:from]} -> #{hop[:to]}", "",
         "- Lockfile: `#{lockfile}` (#{hop[:locked] || 'no rails'})", "- Hop source: #{hop[:source]}", ""]
  if capped.empty?
    out << "No locked gem declares a Rails limit that excludes #{hop[:to]}."
  else
    out << "## Capped below #{hop[:to]} (#{capped.length})" << ""
    out << "Each gem's gemspec excludes Rails #{hop[:to]}: bump it to a release that allows it, replace it, or drop it."
    out << "" << "| Gem | Locked | Source | Declared limit | In Gemfile | Pulled in by |"
    out << "|-----|--------|--------|----------------|------------|--------------|"
    capped.each do |g|
      out << "| #{g[:name]} | #{g[:version]} | #{g[:source]} | #{g[:limits].join('; ')} | " \
             "#{g[:direct] ? 'yes' : 'no'} | #{g[:parents].join(', ')} |"
    end
  end
  out << "" << "Not checked: limits on non-Rails gems, limits stated only in a README, and runtime breakage."
  out.join("\n") + "\n"
end

def self_test
  lock = parse_lockfile(<<-LOCK)
GEM
  specs:
    capped (1.0)
      actionpack (>= 3.1, < 4.1)
    floor (1.0)
      activerecord (>= 4.1.2)
    parent (1.0)
      child
    child (1.0)
      railties (< 4.1)
    rails (4.0.13)
      only_rails
    only_rails (1.0)
      actionpack (< 4.1)
    variant (1.0-java)
      railties (>= 4.0)
    variant (1.0)
      railties (>= 4.0, < 4.1)

DEPENDENCIES
  capped
  floor
  parent
  rails
  variant!
LOCK
  got = capped_gems(lock, "4.1")
  child = got.find { |g| g[:name] == "child" }
  failures = []
  failures << "capped gems: #{got.map { |g| g[:name] }.inspect}" unless got.map { |g| g[:name] } == %w[capped child variant]
  failures << "child should name its parent" unless child && child[:parents] == ["parent"] && !child[:direct]
  failures << "variant should show its plain version" unless lock[:specs]["variant"][:version] == "1.0"
  if failures.empty?
    puts "gem_limits: self-test OK"
    exit 0
  end
  failures.each { |f| warn "FAIL: #{f}" }
  exit 1
end

if $PROGRAM_NAME == __FILE__
  opts = { :root => ".", :lockfile => "Gemfile.lock" }
  OptionParser.new do |o|
    o.banner = "Usage: ruby gem_limits.rb [--target X.Y] [--root DIR] [--lockfile FILE]"
    o.on("--target VERSION", "target Rails version (default: next hop after the lockfile's rails)") { |v| opts[:target] = v }
    o.on("--root DIR", "app root (default: .)") { |v| opts[:root] = v }
    o.on("--lockfile FILE", "lockfile relative to --root (default: Gemfile.lock)") { |v| opts[:lockfile] = v }
    o.on("--self-test", "run built-in assertions and exit") { self_test }
  end.parse!

  lockfile = File.expand_path(opts[:lockfile], File.expand_path(opts[:root]))
  abort("gem_limits: #{lockfile} not found") unless File.file?(lockfile)
  text = File.read(lockfile, :encoding => "UTF-8")
  hop = Hop.resolve(text, opts[:target], File.basename(lockfile))
  abort("gem_limits: #{hop[:error]}") if hop[:error]
  abort("gem_limits: #{opts[:lockfile]} already resolves Rails #{hop[:to]}; check the other lockfile with --lockfile") if hop[:reached]
  print render(hop, opts[:lockfile], capped_gems(parse_lockfile(text), hop[:to]))
end
