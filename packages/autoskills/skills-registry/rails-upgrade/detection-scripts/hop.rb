# frozen_string_literal: true

require "rubygems"

# The hop an app is on, shared by scan_patterns.rb and gem_limits.rb so both
# name the same hop. Runs with the app's Ruby: stdlib only, Ruby 2.1 compatible.
module Hop
  GUIDES_DIR = File.expand_path("../version-guides", __dir__)

  # The version guide whose hop ends at `target`, or nil.
  def self.guide_for(target)
    Dir[File.join(GUIDES_DIR, "upgrade-*-to-#{target}.md")].first
  end

  # The version a hop to `target` starts from (7.0 -> "6.1"), or nil.
  def self.from_for(target)
    g = guide_for(target)
    g ? File.basename(g)[/\Aupgrade-(\d+\.\d+)-to-/, 1] : nil
  end

  # { :from, :to, :locked, :source, :reached } or { :error }. The hop comes
  # from the version guides; the lockfile's rails (or railties, for apps
  # without the rails gem) is the current version. :reached is true when the
  # lockfile is already on the --target version or past it.
  def self.resolve(lock_text, target_arg, lock_name = "Gemfile.lock")
    name = %w[rails railties].find { |n| lock_text.to_s =~ /^    #{n} \((\d+\.\d+)[^)]*\)/ }
    current = name ? $1 : nil
    locked = name ? lock_text[/^    #{name} \(([^)\s]+)\)/, 1] : nil
    if target_arg
      t = target_arg.to_s.strip
      t = "#{t[0..-2]}.#{t[-1]}" if t =~ /\A\d{2,3}\z/
      target = t[/\A(\d+\.\d+)(?:\.\d+)*\z/, 1]
      return { :error => "--target #{target_arg.inspect} is not a Rails version like 4.1" } unless target
      from = from_for(target)
      return { :error => "no version guide ends at Rails #{target}" } unless from
      source = "--target"
    else
      return { :error => "no rails or railties in #{lock_name}; pass --target X.Y" } unless current
      g = Dir[File.join(GUIDES_DIR, "upgrade-#{current}-to-*.md")].first
      return { :error => "no version guide starts at Rails #{current}; pass --target X.Y" } unless g
      from, target = current, File.basename(g)[/-to-(\d+\.\d+)\.md\z/, 1]
      source = "#{lock_name} pins #{name} #{locked}"
    end
    reached = current && Gem::Version.new(target) <= Gem::Version.new(current) ? true : false
    { :from => from, :to => target, :locked => name ? "#{name} #{locked}" : nil, :source => source, :reached => reached }
  end
end
